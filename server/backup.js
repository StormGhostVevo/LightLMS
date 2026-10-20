import Database from "better-sqlite3";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync, createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

// A backup is the whole database (people, courses, results, certificates, images) in one gzip-compressed SQLite file.
// Every backup is opened and checked before it is trusted, because an unchecked backup is a hope, not a backup.

/** lightlms-YYYYMMDD-HHMMSS-mmm.sqlite.gz, with an optional label: -pre-migrate, -pre-restore */
export const BACKUP_NAME = /^lightlms-\d{8}-\d{6}-\d{3}(-[a-z]+(?:-[a-z]+)*)?\.sqlite\.gz$/;
const MAX_UNPACKED = 4 * 1024 ** 3; // refuse to unpack more than 4 GB from one file
const REQUIRED_TABLES = ["schema_migrations", "users", "courses"];

const pad = (n, w = 2) => String(n).padStart(w, "0");
const stamp = d =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-${pad(d.getUTCMilliseconds(), 3)}`;
const nameFor = (label, date = new Date()) => `lightlms-${stamp(date)}${label ? `-${label}` : ""}.sqlite.gz`;
export const labelOf = name => BACKUP_NAME.exec(name)?.[1]?.slice(1) ?? "";

/** When a backup was made, read from its name. */
const createdAt = name => {
  const m = /^lightlms-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})/.exec(name);
  if (!m) return null;
  const [year, month, day, hour, minute, second, ms] = m.slice(1).map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms)).toISOString();
};

/**
 * Opens a database file read-only and checks it is intact and really is one of ours.
 * @returns {{ migrations: number, users: number, courses: number }}
 */
export function verifyDbFile(path) {
  let db;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const integrity = db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error(`the database file is damaged (${integrity})`);
    const tables = new Set(
      /** @type {any[]} */ (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).map(
        t => t.name,
      ),
    );
    for (const t of REQUIRED_TABLES)
      if (!tables.has(t)) throw new Error(`it is not a lightlms database (no ${t} table)`);
    const count = t => /** @type {number} */ (db.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get());
    return { migrations: count("schema_migrations"), users: count("users"), courses: count("courses") };
  } catch (err) {
    throw new Error(`That isn't a usable backup: ${err.message}`);
  } finally {
    db?.close();
  }
}

/** Unpacks a backup to a plain SQLite file, refusing anything that unpacks to something absurdly large. */
async function unpack(gzPath, outPath) {
  let total = 0;
  const cap = new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length;
      total > MAX_UNPACKED ? cb(new Error("it unpacks to more than 4 GB")) : cb(null, chunk);
    },
  });
  try {
    await pipeline(createReadStream(gzPath), createGunzip(), cap, createWriteStream(outPath));
  } catch (err) {
    rmSync(outPath, { force: true });
    throw new Error(`That isn't a usable backup: it can't be unpacked (${err.message})`);
  }
}

/** Unpacks a backup to a temporary file, checks it, and cleans up. Returns what is in it. */
export async function verifyBackup(gzPath) {
  const tmp = `${gzPath}.verify-${process.pid}.sqlite`;
  try {
    await unpack(gzPath, tmp);
    return verifyDbFile(tmp);
  } finally {
    rmSync(tmp, { force: true });
  }
}

const gzipFileTo = async (from, to) => {
  const partial = `${to}.partial`;
  await pipeline(createReadStream(from), createGzip({ level: 6 }), createWriteStream(partial));
  renameSync(partial, to); // appears complete or not at all
};

/**
 * Makes a verified, compressed backup while the server keeps running. SQLite's own backup copies a consistent
 * snapshot even if people are using the site.
 * @param {import("better-sqlite3").Database} db
 * @param {string} dir
 * @param {string} [label] "" for a scheduled or manual backup, or a reason such as "pre-restore"
 */
export async function createBackup(db, dir, label = "") {
  mkdirSync(dir, { recursive: true });
  const name = nameFor(label);
  const tmp = join(dir, `.tmp-${process.pid}-${name}.sqlite`);
  try {
    await db.backup(tmp);
    const info = verifyDbFile(tmp);
    await gzipFileTo(tmp, join(dir, name));
    return { name, bytes: statSync(join(dir, name)).size, createdAt: createdAt(name), ...info };
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** The same, done in one go with nothing else running. Used just before a migration, when the server isn't serving yet. */
export function backupSync(db, dir, label = "") {
  mkdirSync(dir, { recursive: true });
  const name = nameFor(label);
  const tmp = join(dir, `.tmp-${process.pid}-${name}.sqlite`);
  try {
    db.prepare("VACUUM INTO ?").run(tmp);
    verifyDbFile(tmp);
    const partial = join(dir, `${name}.partial`);
    writeFileSync(partial, gzipSync(readFileSync(tmp)));
    renameSync(partial, join(dir, name));
    return name;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Backups in a folder, newest first. Anything that isn't a backup (temporary files, other files) is ignored. */
export function listBackups(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => BACKUP_NAME.test(f))
    .sort()
    .reverse()
    .map(name => ({
      name,
      label: labelOf(name),
      bytes: statSync(join(dir, name)).size,
      createdAt: createdAt(name),
    }));
}

/**
 * Deletes old backups: the newest `keep` ordinary ones and the newest `keepSafety` of each safety kind
 * (pre-migrate, pre-restore) stay. Returns the names removed.
 */
export function pruneBackups(dir, { keep = 14, keepSafety = 5 } = {}) {
  const seen = new Map();
  const removed = [];
  for (const b of listBackups(dir)) {
    const n = (seen.get(b.label) ?? 0) + 1;
    seen.set(b.label, n);
    if (n > (b.label ? keepSafety : keep)) {
      rmSync(join(dir, b.name), { force: true });
      removed.push(b.name);
    }
  }
  return removed;
}

/**
 * Backs up now if the newest ordinary backup is older than `everyHours`, then checks again every few minutes.
 * A failure is logged and tried again next time; it never stops the site.
 */
export function startBackupSchedule({ db, dir, everyHours, keep, log, checkEveryMs = 10 * 60 * 1000 }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const newest = listBackups(dir).find(b => !b.label);
      const due = !newest || Date.now() - Date.parse(newest.createdAt) >= everyHours * 3600 * 1000;
      if (!due) return;
      const b = await createBackup(db, dir);
      const removed = pruneBackups(dir, { keep });
      log?.info("backup made", { file: b.name, bytes: b.bytes, users: b.users, pruned: removed.length });
    } catch (err) {
      log?.error("backup failed", { err });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, checkEveryMs);
  timer.unref();
  setImmediate(tick);
  return { stop: () => clearInterval(timer), runNow: tick };
}

// ---- the lock file: tells a restore that the server is running ----

/** Records this process as the one using the database. Returns a function that releases it. */
export function holdLock(dbPath) {
  const lock = `${dbPath}.lock`;
  writeFileSync(lock, String(process.pid));
  const release = () => {
    try {
      if (readFileSync(lock, "utf8") === String(process.pid)) rmSync(lock, { force: true });
    } catch {
      /* already gone */
    }
  };
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (release(), process.exit(0)));
  return release;
}

const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // it exists, we just can't signal it
  }
};

/**
 * Replaces the database with a backup. The server must be stopped. Steps: check the backup, refuse if the server is
 * running, keep a safety copy of what is there now, then swap the file in.
 * @param {{ file: string, dbPath: string, backupDir: string }} options file may be "latest"
 */
export async function restoreBackup({ file, dbPath, backupDir }) {
  const source = file === "latest" ? listBackups(backupDir).find(b => !b.label)?.name : file;
  if (!source) throw new Error("There are no backups to restore.");
  const gz = existsSync(source) ? source : join(backupDir, source);
  if (!existsSync(gz)) throw new Error(`Can't find the backup ${source}.`);

  const info = await verifyBackup(gz);

  const lock = `${dbPath}.lock`;
  if (existsSync(lock)) {
    const pid = Number.parseInt(readFileSync(lock, "utf8"), 10);
    if (pid && alive(pid))
      throw new Error(`The server is running (process ${pid}). Stop it before restoring.`);
  }

  let safetyCopy = null;
  if (existsSync(dbPath)) {
    const current = new Database(dbPath);
    try {
      safetyCopy = (await createBackup(current, backupDir, "pre-restore")).name;
    } finally {
      current.close();
    }
  }

  mkdirSync(dirname(dbPath), { recursive: true });
  const staged = `${dbPath}.restoring`;
  await unpack(gz, staged);
  verifyDbFile(staged);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
  renameSync(staged, dbPath);
  return { restoredFrom: gz, safetyCopy, ...info };
}
