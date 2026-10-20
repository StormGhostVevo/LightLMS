import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { backupSync } from "./backup.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

// Line endings are ignored, so a Windows checkout of the same file has the same checksum.
const checksum = sql => createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");

/**
 * Opens the database and brings it up to date by applying any numbered migrations that haven't run yet.
 *
 * Safety rules:
 * - A migration that has been applied is fixed. If its file has since been edited, the server refuses to start,
 *   because the database and the code would no longer agree about what the schema is.
 * - If the database has migrations this code doesn't know about, it was written by a newer version: refuse to start
 *   rather than run an old version on a newer database.
 * - Before applying anything to a database that already holds data, a backup is taken (label "pre-migrate").
 *
 * @param {string} path a file path, or ":memory:"
 * @param {{ backupDir?: string | null, log?: import("./logger.js").Logger }} [options]
 *   `backupDir`: where the pre-migration backup goes. Defaults to a `backups` folder beside the database. null turns it off.
 */
export function openDb(path, { backupDir, log } = {}) {
  const onDisk = path !== ":memory:";
  if (onDisk) mkdirSync(dirname(path), { recursive: true });
  const existed = onDisk && existsSync(path);
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  if (!db.prepare("SELECT 1 FROM pragma_table_info('schema_migrations') WHERE name = 'checksum'").get())
    db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT"); // databases from before checksums existed

  const files = new Map(
    readdirSync(migrationsDir)
      .filter(f => f.endsWith(".sql"))
      .sort()
      .map(f => [f, readFileSync(join(migrationsDir, f), "utf8")]),
  );
  /** @type {{ name: string, checksum: string | null }[]} */
  const applied = /** @type {any} */ (
    db.prepare("SELECT name, checksum FROM schema_migrations ORDER BY name").all()
  );

  for (const row of applied) {
    const sql = files.get(row.name);
    if (sql === undefined)
      throw new Error(
        `The database has migration ${row.name}, which this version of the code doesn't have. It was probably written by a newer version. Update the code instead of running an older one.`,
      );
    if (row.checksum === null) {
      // Applied before checksums existed: record what the file is now. This is the one time we trust it.
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE name = ?").run(checksum(sql), row.name);
    } else if (row.checksum !== checksum(sql)) {
      throw new Error(
        `Migration ${row.name} was changed after it was applied. Applied migrations must never be edited: put the change in a new migration instead.`,
      );
    }
  }

  const appliedNames = new Set(applied.map(r => r.name));
  const pending = [...files.keys()].filter(f => !appliedNames.has(f));
  const newestApplied = applied.at(-1)?.name;
  if (newestApplied && pending.some(f => f < newestApplied))
    throw new Error(
      `Migration ${pending.find(f => f < newestApplied)} is new but sorts before one that has already been applied (${newestApplied}). Give it a later number.`,
    );

  if (pending.length && applied.length && existed && backupDir !== null) {
    const file = backupSync(db, backupDir ?? join(dirname(path), "backups"), "pre-migrate");
    log?.info("backed up before migrating", { file, pending: pending.length });
  }

  for (const name of pending) {
    db.transaction(() => {
      db.exec(files.get(name));
      db.prepare("INSERT INTO schema_migrations (name, applied_at, checksum) VALUES (?, ?, ?)").run(
        name,
        new Date().toISOString(),
        checksum(files.get(name)),
      );
    })();
    log?.info("migration applied", { migration: name });
  }
  return db;
}
