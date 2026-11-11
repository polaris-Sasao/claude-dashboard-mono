// agent setup：Claude Code の設定（~/.claude/settings.json）への登録（単独 PC 版）
// 登録するのは、危険操作のガード（PreToolUse・同期）・statusLine・利用枠の mod だけ。
// セッションの一覧・会話・放置・ファイル競合は、監視サーバーが ~/.claude のファイルを直接読むため、hooks のイベントは送らない。
// settings.json は --apply を付けたときだけ、差分を表示して確認を取ってから書き換える（ほかの設定は変えない）

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import pkg from "../package.json";
import { AGENT_DIR, CONFIG_PATH, isLocalUrl, loadConfig } from "./common";
import { MARKETPLACE_NAME, modFiles, PLUGIN_ID } from "./mod";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const BIN_DIR = join(AGENT_DIR, "bin");
const BIN_PATH = join(BIN_DIR, "kanseishitsu-agent.exe");
/** 利用枠の mod を置くローカルのマーケットプレイス（mod.ts） */
const MARKETPLACE_DIR = join(AGENT_DIR, "plugins");

/** 設定ファイルに書くパス。Windows でも Git Bash で壊れないよう / 区切りにする */
const slashPath = (p: string) => p.replace(/\\/g, "/");

function ask(question: string, def?: string): string {
  const v = prompt(def ? `${question} [${def}]:` : `${question}:`);
  return (v ?? "").trim() || def || "";
}

/** コンパイル済みの実行ファイルとして動いているか（bun run で動かしている場合は false） */
function isCompiled(): boolean {
  return !/^bun(\.exe)?$/i.test(basename(process.execPath));
}

type HookHandler = { type: string; command?: string; args?: string[]; [k: string]: unknown };
type MatcherGroup = { matcher?: string; hooks?: HookHandler[] };
type Settings = {
  hooks?: Record<string, MatcherGroup[]>;
  statusLine?: { type?: string; command?: string; [k: string]: unknown };
  extraKnownMarketplaces?: Record<string, { source?: Record<string, unknown>; [k: string]: unknown }>;
  enabledPlugins?: Record<string, boolean>;
  [k: string]: unknown;
};

export function desiredEntries(binPath: string) {
  const cmd = slashPath(binPath);
  // 危険操作のガード：Claude Code が結果を待つ同期の登録。既定の待ち時間（600秒）は長すぎるため 5 秒にする。
  // 時間切れのときは結果が捨てられ、ふつうの許可の流れに戻る（止まらない）。
  // args を指定するとシェルを通さずに直接起動される（Windows のパス問題を避けられる）
  const hooks: Record<string, MatcherGroup[]> = {
    PreToolUse: [{ matcher: "Bash|PowerShell", hooks: [{ type: "command", command: cmd, args: ["guard"], timeout: 5 }] }],
  };
  // statusLine は args を持たないためシェル経由で起動される。空白を含むパスだけ引用符で囲む
  const statusCommand = (/\s/.test(cmd) ? `"${cmd}"` : cmd) + " statusline";
  return { hooks, statusLine: { type: "command", command: statusCommand, padding: 0 }, cmd };
}

/**
 * 既存の設定に追記した結果と、変更点の説明を返す。
 * legacyPaths（以前に登録した呼び出し先）の登録は、新しい呼び出し先に置き換える。
 * 前身（複数 PC 版）が登録したイベント送信（kanseishitsu-agent hook <イベント>）は外す。
 * marketplaceDir を渡したときは、利用枠の mod のマーケットプレイスを登録して mod を有効にする
 */
export function mergeSettings(
  current: Settings,
  binPath: string,
  legacyPaths: string[] = [],
  marketplaceDir?: string,
): { next: Settings; changes: string[]; warnings: string[] } {
  const want = desiredEntries(binPath);
  const legacy = legacyPaths.map(slashPath).filter((p) => p !== want.cmd);
  const next: Settings = structuredClone(current);
  const changes: string[] = [];
  const warnings: string[] = [];
  next.hooks ??= {};
  // 登録は「呼び出し先」と「サブコマンド（guard など）」の組で見分ける
  const sub = (h: HookHandler) => h.args?.[0] ?? "";
  // 前身のイベント送信の登録を外す（呼び出し先がこのエージェントで、サブコマンドが hook のもの）
  const ours = (h: HookHandler) => /kanseishitsu-agent(\.exe)?$/i.test(slashPath(h.command ?? ""));
  for (const [ev, groups] of Object.entries(next.hooks)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !(ours(h) && sub(h) === "hook")) }))
      .filter((g) => g.hooks.length > 0);
    const removed = groups.reduce((n, g) => n + (g.hooks?.length ?? 0), 0) - kept.reduce((n, g) => n + g.hooks.length, 0);
    if (removed === 0) continue;
    if (kept.length > 0) next.hooks[ev] = kept;
    else delete next.hooks[ev];
    changes.push(`hooks.${ev} から前身のイベント送信の登録 ${removed} 件を外す`);
  }
  for (const [ev, groups] of Object.entries(want.hooks)) {
    const existing = next.hooks[ev] ?? [];
    const isLegacy = (g: MatcherGroup) => g.hooks?.some((h) => legacy.includes(slashPath(h.command ?? "")));
    let list = existing.filter((g) => !isLegacy(g));
    const replaced = list.length < existing.length;
    const added: string[] = [];
    for (const g of groups) {
      const h = g.hooks![0]!;
      const already = list.some((x) => x.hooks?.some((y) => slashPath(y.command ?? "") === want.cmd && sub(y) === sub(h)));
      if (already) continue;
      list = [...list, g];
      added.push(sub(h));
    }
    if (!replaced && added.length === 0) continue;
    next.hooks[ev] = list;
    if (replaced) changes.push(`hooks.${ev} の登録を ${want.cmd} の呼び出しに置き換え`);
    else
      changes.push(
        `hooks.${ev} に追加${added.includes("guard") ? "（危険操作のガード）" : ""}（既存 ${existing.length} 件はそのまま）`,
      );
  }
  const sl = next.statusLine;
  const slLegacy = sl && legacy.some((p) => [p, `"${p}"`].some((q) => slashPath(sl.command ?? "") === `${q} statusline`));
  if (!sl || slLegacy) {
    next.statusLine = want.statusLine;
    changes.push(`statusLine を設定: ${want.statusLine.command}${slLegacy ? `（以前: ${sl!.command}）` : ""}`);
  } else if (!slashPath(sl.command ?? "").includes(want.cmd)) {
    warnings.push(
      `statusLine は既に設定されているため変更しません（現在: ${sl.command}）。` +
        `利用枠・モデルの送信には、現在のスクリプトから「${want.statusLine.command}」を呼ぶか、置き換えてください。`,
    );
  }
  if (marketplaceDir) {
    const path = slashPath(marketplaceDir);
    const known = next.extraKnownMarketplaces?.[MARKETPLACE_NAME];
    if (known?.source?.source !== "directory" || known.source.path !== path) {
      next.extraKnownMarketplaces = { ...next.extraKnownMarketplaces, [MARKETPLACE_NAME]: { source: { source: "directory", path } } };
      changes.push(`extraKnownMarketplaces.${MARKETPLACE_NAME} を設定: ${path}（利用枠の mod）`);
    }
    const enabled = next.enabledPlugins?.[PLUGIN_ID];
    if (enabled === false) {
      warnings.push(`利用枠の mod（${PLUGIN_ID}）は無効にされているため変更しません。VS Code・Desktop の利用枠を送るには有効にしてください。`);
    } else if (enabled !== true) {
      next.enabledPlugins = { ...next.enabledPlugins, [PLUGIN_ID]: true };
      changes.push(`enabledPlugins に ${PLUGIN_ID} を追加（VS Code・Desktop のセッションの利用枠を送る）`);
    }
  }
  return { next, changes, warnings };
}

/** 利用枠の mod のマーケットプレイスを置く（既存のファイルは書き換える） */
function writeMarketplace(agentCmd: string): void {
  for (const [rel, content] of Object.entries(modFiles(agentCmd, pkg.version))) {
    const p = join(MARKETPLACE_DIR, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  console.log(`利用枠の mod を配置しました: ${MARKETPLACE_DIR}`);
}

export async function setup(argv: string[]): Promise<void> {
  const apply = argv.includes("--apply");
  const cfg = loadConfig();

  console.log("Claude 管制室 エージェントの設定（単独 PC 版）\n");
  // 設定ファイルは、送り先を既定（http://localhost:8790）から変えるときだけ要る。
  // 前身（複数 PC 版）の設定（ほかの PC の送り先・トークン）が残っていれば、同じ PC の中だけの内容に書き直す
  let saved: Record<string, unknown> | null = null;
  try {
    saved = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
  } catch {
    saved = null;
  }
  const stale = !!saved && ("token" in saved || "hostLabel" in saved || typeof saved.serverUrl !== "string" || !isLocalUrl(saved.serverUrl));
  if (!saved || stale) {
    mkdirSync(AGENT_DIR, { recursive: true });
    if (saved) {
      const backup = `${CONFIG_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      copyFileSync(CONFIG_PATH, backup);
      console.log(`前身の設定を書き直します（バックアップ: ${backup}）`);
    }
    const { guardMode, timeoutMs } = cfg;
    writeFileSync(CONFIG_PATH, JSON.stringify({ serverUrl: cfg.serverUrl, guardMode, timeoutMs }, null, 2) + "\n");
    console.log(`設定ファイルを${saved ? "書き直しました" : "作りました"}: ${CONFIG_PATH}`);
  }
  console.log(`送り先: ${cfg.serverUrl}`);

  // 接続確認（監視サーバーが止まっていても登録は続ける）
  try {
    const res = await fetch(cfg.serverUrl.replace(/\/+$/, "") + "/healthz", { signal: AbortSignal.timeout(5000) });
    console.log(res.ok ? "監視サーバーへの接続: OK" : `監視サーバーへの接続: HTTP ${res.status}`);
  } catch (e) {
    console.log(`監視サーバーへの接続: 失敗（${e instanceof Error ? e.message : e}）。監視サーバーが起動していなくても登録はできます`);
  }

  // 実行ファイルを決まった場所に置く（設定ファイルに書くパスを固定するため）
  let binPath = process.execPath;
  const legacyPaths: string[] = [];
  if (isCompiled()) {
    mkdirSync(BIN_DIR, { recursive: true });
    if (slashPath(process.execPath) !== slashPath(BIN_PATH)) {
      // 別名にコピーしてから名前を付け替える（動いている実行ファイルを途中まで書いた状態にしない）
      const tmp = `${BIN_PATH}.new`;
      copyFileSync(process.execPath, tmp);
      renameSync(tmp, BIN_PATH);
      console.log(`実行ファイルを配置しました: ${BIN_PATH}`);
    }
    binPath = BIN_PATH;
    writeMarketplace(slashPath(binPath));
  } else {
    console.log("（開発モード：bun で実行中のため、実行ファイルと利用枠の mod の配置は行いません）");
  }

  const current: Settings = existsSync(SETTINGS_PATH) ? JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) : {};
  const { next, changes, warnings } = mergeSettings(current, binPath, legacyPaths, isCompiled() ? MARKETPLACE_DIR : undefined);

  console.log(`\n${SETTINGS_PATH} への変更内容:`);
  if (changes.length === 0) console.log("  （変更なし：登録済みです）");
  for (const c of changes) console.log(`  + ${c}`);
  for (const w of warnings) console.log(`  ! ${w}`);

  if (!apply) {
    console.log("\n登録する内容（手動で追記する場合）:");
    const want = desiredEntries(binPath);
    const mod = isCompiled()
      ? {
          extraKnownMarketplaces: { [MARKETPLACE_NAME]: { source: { source: "directory", path: slashPath(MARKETPLACE_DIR) } } },
          enabledPlugins: { [PLUGIN_ID]: true },
        }
      : {};
    console.log(JSON.stringify({ hooks: want.hooks, statusLine: want.statusLine, ...mod }, null, 2));
    console.log("\n自動で追記するには、内容を確認のうえ `setup --apply` を実行してください。");
    return;
  }
  if (changes.length === 0) return;
  const ok = ask("\nこの内容で settings.json を書き換えますか？ (y/N)", "N");
  if (!/^y(es)?$/i.test(ok)) {
    console.log("中止しました。settings.json は変更していません。");
    return;
  }
  if (existsSync(SETTINGS_PATH)) {
    const backup = `${SETTINGS_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(SETTINGS_PATH, backup);
    console.log(`バックアップ: ${backup}`);
  } else {
    mkdirSync(join(homedir(), ".claude"), { recursive: true });
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2) + "\n");
  console.log("書き換えました。新しく起動した Claude Code のセッションから反映されます。");
}
