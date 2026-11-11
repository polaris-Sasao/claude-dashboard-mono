import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

export function openDb(path: string): Database {
  // メモリ上のデータベース（テスト）ではフォルダを作らない。Windows では mkdir('.') が EEXIST で失敗する
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 3000");
  migrate(db);
  return db;
}

/** migrations/ の連番 SQL のうち未適用のものを順に実行する */
function migrate(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(
    db.query<{ name: string }, []>("SELECT name FROM schema_migrations").all().map((r) => r.name),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(f, new Date().toISOString());
    })();
    console.log(`[db] migration applied: ${f}`);
  }
}
