import Database from "better-sqlite3";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

// Opens the database and applies any numbered migrations that haven't run yet.
export function openDb(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set(db.prepare("SELECT name FROM schema_migrations").pluck().all());
  for (const file of readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    db.transaction(() => {
      db.exec(readFileSync(join(migrationsDir, file), "utf8"));
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
    })();
  }
  return db;
}
