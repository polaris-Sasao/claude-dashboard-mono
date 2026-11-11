// Claude 管制室 サーバー（単独 PC 版）
//   ・~/.claude/sessions と会話記録を一定間隔で読み、まとまりごとのセッション一覧を作る
//   ・利用枠（statusLine・mod）と危険操作のガードの知らせを、同じ PC のエージェントから受ける
//   ・画面（localhost）へ WebSocket で配信する
// 127.0.0.1 だけで待ち受け、Host・Origin が localhost でないリクエストは断る

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HookIngest, StatuslineIngest, WsMessage } from "@kanseishitsu/shared";
import { dismissAlert, evaluateAlerts, updateDangerOutcomes, type Touch } from "./alerts";
import { DATA_DIR, DB_PATH, loadConfig } from "./config";
import { sessionTokenUsage } from "./local/tokens";
import { recordTranscriptCosts } from "./usage";
import { purgeOld } from "./retention";
import { openDb } from "./db";
import { processHook, processStatusline, recordLiveSessions } from "./ingest";
import { ensureLocalHost, isLocalRequest, type HostRow } from "./localhost";
import { TURN_LIMIT } from "@kanseishitsu/shared";
import { ConversationStore } from "./local/conversation";
import { snapshotProcesses } from "./local/processes";
import { readLiveSessions, type LiveSession } from "./local/sessions";
import { buildSnapshot, snapshotKey } from "./state";
import { sessionDetail } from "./views";

const cfg = loadConfig();
const db = openDb(DB_PATH);
const localHost = ensureLocalHost(db);
const WEB_DIST = join(import.meta.dir, "..", "..", "web", "dist");

// ---- 配信 ----

let server: ReturnType<typeof Bun.serve> | null = null;
/** 直近に読んだ起動中のセッション */
let live: LiveSession[] = [];
/** 起動中のセッションの会話記録の読み取り状態（続きだけを読む） */
const conversations = new ConversationStore();
const snapshot = () => buildSnapshot(db, cfg, live);
let lastKey = "";
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

// 保持期間を過ぎた記録を、起動時と 6 時間ごとに消す
function purge(): void {
  try {
    const n = purgeOld(db, cfg.retentionDays);
    const total = Object.values(n).reduce((a, b) => a + b, 0);
    if (total > 0) console.log(`[retention] ${cfg.retentionDays}日より前の記録を削除: ${JSON.stringify(n)}`);
  } catch (e) {
    console.error("[retention] failed", e);
  }
}
purge();
setInterval(purge, 6 * 3600_000);
/** ファイル競合の判定に使う、起動中のセッション（とサブエージェント）の編集 */
function collectTouches(): Touch[] {
  const out: Touch[] = [];
  for (const s of live) {
    if (!s.transcriptPath) continue;
    for (const e of conversations.get(s.transcriptPath).edits) out.push({ sessionId: s.sessionId, agentId: null, ...e });
    for (const sub of conversations.subagentEdits(s.transcriptPath))
      for (const e of sub.edits) out.push({ sessionId: s.sessionId, agentId: sub.agentId, ...e });
  }
  return out;
}

function broadcastIfChanged(): void {
  try {
    evaluateAlerts(db, cfg, { live, touches: collectTouches() }, localHost.host_id);
    updateDangerOutcomes(db, (sessionId, toolUseId) => {
      const path = live.find((s) => s.sessionId === sessionId)?.transcriptPath;
      if (!path) return null;
      const conv = conversations.get(path);
      return { outcome: conv.outcome(toolUseId), promptAfter: (at) => conv.promptAfter(at) };
    });
  } catch (e) {
    console.error("[alerts] evaluate failed", e);
  }
  const state = snapshot();
  const key = snapshotKey(state);
  if (key === lastKey) return;
  lastKey = key;
  const msg: WsMessage = { type: "snapshot", state };
  server?.publish("state", JSON.stringify(msg));
}

/** 受信が続いても 200ms にまとめて配信する */
function scheduleBroadcast(): void {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcastIfChanged();
  }, 200);
}

// 消費内訳の見積もり：起動中のセッションの会話記録から、トークン数を 1 分ごとに数える（statusLine のない VS Code・Desktop の分）
const TOKENS_STATE_DIR = join(DATA_DIR, "usage");
let lastTokenCount = 0;
function countTokens(now = new Date()): void {
  if (now.getTime() - lastTokenCount < 60_000) return;
  lastTokenCount = now.getTime();
  for (const s of live) {
    try {
      const buckets = s.transcriptPath ? sessionTokenUsage(s.sessionId, s.transcriptPath, TOKENS_STATE_DIR, now) : null;
      if (buckets) recordTranscriptCosts(db, localHost.host_id, s.sessionId, buckets, now);
    } catch (e) {
      console.error("[tokens] failed", s.sessionId, e);
    }
  }
}

// セッションのファイルを一定間隔で読み直す（ファイル監視は Windows で取りこぼしがあるため使わない）
let scanning = false;
async function scan(): Promise<void> {
  if (scanning) return;
  scanning = true;
  try {
    const sessions = readLiveSessions(await snapshotProcesses());
    const paths = new Set<string>();
    for (const s of sessions) {
      if (!s.transcriptPath) continue;
      paths.add(s.transcriptPath);
      const conv = conversations.get(s.transcriptPath);
      const last = conv.list(1)[0];
      s.lastPrompt = last ? last.prompt.slice(0, 200) : null;
      s.players = conv.players();
      s.todos = conv.todos;
    }
    conversations.retain(paths);
    live = sessions;
    recordLiveSessions(db, localHost.host_id, live);
    countTokens();
    broadcastIfChanged();
  } catch (e) {
    console.error("[scan] failed", e);
  } finally {
    scanning = false;
  }
}
await scan();
setInterval(scan, cfg.scanIntervalMs);
// 接続維持のための ping
setInterval(() => {
  const msg: WsMessage = { type: "ping", at: new Date().toISOString() };
  server?.publish("state", JSON.stringify(msg));
}, 25_000);

// ---- HTTP ----

type Env = { Variables: { host: HostRow } };
const app = new Hono<Env>();

// ほかの Web サイトからの送信・読み取りを断る（DNS リバインディング対策）
app.use("*", async (c, next) => {
  if (!isLocalRequest(c.req.header("Host"), c.req.header("Origin"), cfg.port)) {
    console.warn(`[http] 403 ${c.req.method} ${c.req.path} (Host ${c.req.header("Host") ?? "なし"}, Origin ${c.req.header("Origin") ?? "なし"})`);
    return c.json({ error: "forbidden" }, 403);
  }
  await next();
});

app.get("/healthz", (c) => c.json({ ok: true }));

// 受信系：同じ PC のエージェントから。200 を即座に返してから処理する
const ingest = new Hono<Env>();
ingest.use("*", bodyLimit({ maxSize: 1024 * 1024 }));
ingest.use("*", async (c, next) => {
  c.set("host", localHost);
  await next();
});
ingest.post("/hook", async (c) => {
  const body = await c.req.json<HookIngest>().catch(() => null);
  if (!body || typeof body.payload !== "object") return c.json({ error: "bad request" }, 400);
  const host = c.get("host");
  const now = new Date();
  setTimeout(() => {
    try {
      processHook(db, host, body, now);
      scheduleBroadcast();
    } catch (e) {
      console.error("[ingest/hook]", e);
    }
  }, 0);
  return c.json({ ok: true });
});
ingest.post("/statusline", async (c) => {
  const body = await c.req.json<StatuslineIngest>().catch(() => null);
  if (!body || typeof body.payload !== "object") return c.json({ error: "bad request" }, 400);
  const host = c.get("host");
  const now = new Date();
  setTimeout(() => {
    try {
      processStatusline(db, host, body, now);
      scheduleBroadcast();
    } catch (e) {
      console.error("[ingest/statusline]", e);
    }
  }, 0);
  return c.json({ ok: true });
});
app.route("/api/ingest", ingest);

app.get("/api/state", (c) => c.json(snapshot()));

app.post("/api/alerts/:id/dismiss", (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
  const ok = dismissAlert(db, id);
  if (ok) scheduleBroadcast();
  return c.json({ ok });
});

app.get("/api/sessions/:id", (c) => {
  const id = c.req.param("id");
  const path = live.find((s) => s.sessionId === id)?.transcriptPath;
  const conv = path ? conversations.get(path) : null;
  const d = sessionDetail(snapshot().groups, id, conv?.list(TURN_LIMIT) ?? [], (conv?.size ?? 0) > TURN_LIMIT, conv?.todos ?? null);
  return d ? c.json(d) : c.json({ error: "not found" }, 404);
});

// 存在しない API は、画面の HTML ではなく 404 を返す
app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

if (existsSync(WEB_DIST)) {
  app.use("/*", serveStatic({ root: WEB_DIST }));
  app.get("*", serveStatic({ path: join(WEB_DIST, "index.html") }));
} else {
  app.get("/", (c) => c.text("画面がビルドされていません。bun run build:web を実行してください。", 503));
}

// ---- 起動 ----

server = Bun.serve({
  hostname: cfg.host,
  port: cfg.port,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      // ほかのサイトからの WebSocket 接続を断る
      if (!isLocalRequest(req.headers.get("Host"), req.headers.get("Origin"), cfg.port)) {
        return new Response("forbidden", { status: 403 });
      }
      if (srv.upgrade(req, { data: undefined })) return undefined;
      return new Response("upgrade failed", { status: 400 });
    }
    return app.fetch(req, { srv });
  },
  websocket: {
    open(ws) {
      ws.subscribe("state");
      const msg: WsMessage = { type: "snapshot", state: snapshot() };
      ws.send(JSON.stringify(msg));
    },
    message() {
      // 画面からのメッセージは受け付けない
    },
    close(ws) {
      ws.unsubscribe("state");
    },
  },
});

console.log(`[kanseishitsu] listening on http://localhost:${cfg.port} (db: ${DB_PATH})`);
