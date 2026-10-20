import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { openDb } from "../db.js";
import {
  BACKUP_NAME,
  createBackup,
  backupSync,
  listBackups,
  pruneBackups,
  restoreBackup,
  verifyBackup,
  startBackupSchedule,
} from "../backup.js";
import { hashPassword } from "../auth.js";
import { createLogger } from "../logger.js";
import { PNG } from "./helpers.js";

const dirs = [];
after(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "lightlms-test-"));
  dirs.push(d);
  return d;
};

/** A database file on disk with a bit of everything in it: people, a course, a picture, an attempt, a certificate. */
async function populated(dir) {
  const dbPath = join(dir, "data", "lightlms.sqlite");
  const db = openDb(dbPath, { backupDir: join(dir, "backups") });
  const hash = await hashPassword("correct-horse-battery");
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO users (email, name, role, password_hash, created_at) VALUES ('a@example.com', 'Alex', 'learner', ?, ?)",
  ).run(hash, now);
  const course = db
    .prepare(
      "INSERT INTO courses (title, status, created_at, updated_at) VALUES ('Safety', 'published', ?, ?)",
    )
    .run(now, now).lastInsertRowid;
  db.prepare(
    "INSERT INTO lessons (course_id, position, title, body) VALUES (?, 0, 'L1', '<p>hello</p>')",
  ).run(course);
  db.prepare(
    "INSERT INTO images (key, course_id, kind, mime, bytes, size, created_at) VALUES ('img-key-1', ?, 'lesson', 'image/png', ?, ?, ?)",
  ).run(course, PNG, PNG.length, now);
  db.prepare(
    "INSERT INTO attempts (course_id, user_id, score, total, percent, passed, pass_mark, detail, submitted_at) VALUES (?, 1, 3, 4, 75, 1, 70, '[]', ?)",
  ).run(course, now);
  db.prepare(
    "INSERT INTO certificates (code, user_id, course_id, recipient_name, course_title, issued_at) VALUES ('LL-TEST1-TEST2', 1, ?, 'Alex', 'Safety', ?)",
  ).run(course, now);
  return { db, dbPath, backupDir: join(dir, "backups"), course };
}
const snapshot = db => ({
  users: db.prepare("SELECT email FROM users ORDER BY id").pluck().all(),
  courses: db.prepare("SELECT title FROM courses").pluck().all(),
  image: db.prepare("SELECT bytes FROM images WHERE key = 'img-key-1'").pluck().get(),
  attempts: db.prepare("SELECT score, percent FROM attempts").all(),
  certificate: db.prepare("SELECT code, recipient_name FROM certificates").all(),
});

// ---------------- the restore drill ----------------

test("restore drill: back up, lose data, restore, and everything including images and certificates is back", async () => {
  const { db, dbPath, backupDir } = await populated(tmp());
  const before = snapshot(db);
  const backup = await createBackup(db, backupDir);
  assert.match(backup.name, BACKUP_NAME);
  assert.deepEqual([backup.users, backup.courses], [1, 1]);

  // A bad afternoon: the course is deleted and someone else signs up.
  db.prepare("DELETE FROM courses").run();
  db.prepare(
    "INSERT INTO users (email, role, password_hash, created_at) VALUES ('later@example.com', 'learner', 'x', ?)",
  ).run(new Date().toISOString());
  assert.deepEqual(snapshot(db).courses, []);
  db.close();

  const r = await restoreBackup({ file: backup.name, dbPath, backupDir });
  assert.match(r.safetyCopy, /-pre-restore\.sqlite\.gz$/);
  const restored = openDb(dbPath, { backupDir });
  assert.deepEqual(snapshot(restored), before); // byte for byte, picture included
  assert.deepEqual(Buffer.from(snapshot(restored).image), PNG);
  assert.equal(restored.pragma("integrity_check", { simple: true }), "ok");
  restored.close();

  // What was there just before the restore is not lost: it is the safety copy.
  const safetyCopy = join(backupDir, r.safetyCopy);
  assert.ok((await verifyBackup(safetyCopy)).users === 2);
});

test("restore: 'latest' picks the newest ordinary backup, not a safety copy", async () => {
  const { db, dbPath, backupDir } = await populated(tmp());
  const first = await createBackup(db, backupDir);
  db.prepare(
    "INSERT INTO users (email, role, password_hash, created_at) VALUES ('second@example.com', 'learner', 'x', ?)",
  ).run(new Date().toISOString());
  const second = await createBackup(db, backupDir);
  await createBackup(db, backupDir, "pre-restore"); // newest of all, but a safety copy
  db.close();
  assert.ok(second.name > first.name);
  const r = await restoreBackup({ file: "latest", dbPath, backupDir });
  assert.ok(r.restoredFrom.endsWith(second.name));
  assert.equal(r.users, 2);
});

test("restore: refused while the server is running, allowed when the lock is left over from a crash", async () => {
  const { db, dbPath, backupDir } = await populated(tmp());
  const backup = await createBackup(db, backupDir);
  db.close();
  writeFileSync(`${dbPath}.lock`, String(process.pid)); // a live process
  await assert.rejects(restoreBackup({ file: backup.name, dbPath, backupDir }), /server is running/);
  assert.ok(existsSync(dbPath)); // nothing was touched
  writeFileSync(`${dbPath}.lock`, "999999"); // no such process: a stale lock
  await restoreBackup({ file: backup.name, dbPath, backupDir });
});

test("restore: missing files and empty folders give plain messages", async () => {
  const dir = tmp();
  const dbPath = join(dir, "lightlms.sqlite");
  await assert.rejects(
    restoreBackup({ file: "latest", dbPath, backupDir: join(dir, "backups") }),
    /no backups to restore/,
  );
  await assert.rejects(
    restoreBackup({ file: "lightlms-20260101-000000-000.sqlite.gz", dbPath, backupDir: dir }),
    /Can't find the backup/,
  );
});

test("restore onto a machine with no database yet works (disaster recovery)", async () => {
  const { db, backupDir } = await populated(tmp());
  const backup = await createBackup(db, backupDir);
  const before = snapshot(db);
  db.close();
  const fresh = join(tmp(), "new-machine", "lightlms.sqlite");
  const r = await restoreBackup({
    file: join(backupDir, backup.name),
    dbPath: fresh,
    backupDir: join(tmp(), "b"),
  });
  assert.equal(r.safetyCopy, null); // there was nothing to keep
  const db2 = openDb(fresh, { backupDir: null });
  assert.deepEqual(snapshot(db2), before);
  db2.close();
});

// ---------------- an unchecked backup is a hope, not a backup ----------------

test("verify: damaged, truncated, empty, and foreign files are all refused with a clear message", async () => {
  const { db, backupDir } = await populated(tmp());
  const good = join(backupDir, (await createBackup(db, backupDir)).name);
  assert.equal((await verifyBackup(good)).users, 1);
  const bytes = readFileSync(good);
  const dir = tmp();
  const bad = {
    "flipped bytes": Buffer.concat([bytes.subarray(0, 40), Buffer.alloc(40, 0xff), bytes.subarray(80)]),
    truncated: bytes.subarray(0, Math.floor(bytes.length / 2)),
    "not gzip at all": Buffer.from("this is just some text"),
    empty: Buffer.alloc(0),
    "gzip of text": gzipSync("hello, I am not a database"),
  };
  for (const [what, data] of Object.entries(bad)) {
    const file = join(dir, `${what.replaceAll(" ", "-")}.sqlite.gz`);
    writeFileSync(file, data);
    await assert.rejects(verifyBackup(file), /isn't a usable backup/, what);
    assert.deepEqual(
      readdirSync(dir).filter(f => f.includes("verify")),
      [],
      `${what}: no temp file left behind`,
    );
  }

  // A real SQLite database, but not ours.
  const other = new Database(join(dir, "other.sqlite"));
  other.exec("CREATE TABLE recipes (id INTEGER)");
  other.close();
  writeFileSync(join(dir, "other.sqlite.gz"), gzipSync(readFileSync(join(dir, "other.sqlite"))));
  await assert.rejects(verifyBackup(join(dir, "other.sqlite.gz")), /not a lightlms database/);
});

test("a failed restore leaves the live database exactly as it was", async () => {
  const { db, dbPath, backupDir } = await populated(tmp());
  const before = snapshot(db);
  db.close();
  mkdirSync(backupDir, { recursive: true });
  const junk = join(backupDir, "lightlms-20260101-000000-000.sqlite.gz");
  writeFileSync(junk, gzipSync("not a database"));
  await assert.rejects(restoreBackup({ file: junk, dbPath, backupDir }), /isn't a usable backup/);
  const still = openDb(dbPath, { backupDir: null });
  assert.deepEqual(snapshot(still), before);
  assert.deepEqual(
    readdirSync(join(dbPath, "..")).filter(f => f.endsWith(".restoring")),
    [],
  );
  still.close();
});

// ---------------- keeping the right ones ----------------

test("prune: keeps the newest ordinary backups and a few of each safety kind, and touches nothing else", async () => {
  const { db, backupDir } = await populated(tmp());
  for (let i = 0; i < 8; i++) await createBackup(db, backupDir);
  for (let i = 0; i < 4; i++) await createBackup(db, backupDir, "pre-migrate");
  writeFileSync(join(backupDir, "notes.txt"), "keep me");
  writeFileSync(join(backupDir, ".tmp-leftover.sqlite"), "ignored");
  const newest = listBackups(backupDir).filter(b => !b.label)[0].name;
  const removed = pruneBackups(backupDir, { keep: 3, keepSafety: 2 });
  assert.equal(removed.length, 5 + 2);
  const left = listBackups(backupDir);
  assert.equal(left.filter(b => !b.label).length, 3);
  assert.equal(left.filter(b => b.label === "pre-migrate").length, 2);
  assert.equal(left[0].name > left.at(-1).name, true); // newest first
  assert.ok(left.some(b => b.name === newest));
  assert.ok(existsSync(join(backupDir, "notes.txt")) && existsSync(join(backupDir, ".tmp-leftover.sqlite")));
  assert.deepEqual(listBackups(join(backupDir, "nowhere")), []);
});

test("schedule: backs up when none exists, not again until due, and a failure is logged but never thrown", async () => {
  const { db, backupDir } = await populated(tmp());
  const lines = [];
  const log = createLogger({ write: l => lines.push(JSON.parse(l)) });
  const s = startBackupSchedule({
    db,
    dir: backupDir,
    everyHours: 24,
    keep: 3,
    log,
    checkEveryMs: 3_600_000,
  });
  await s.runNow();
  await s.runNow(); // not due yet
  s.stop();
  assert.equal(listBackups(backupDir).length, 1);
  assert.equal(lines.filter(l => l.msg === "backup made").length, 1);

  // Due again once the newest is old enough.
  const s2 = startBackupSchedule({
    db,
    dir: backupDir,
    everyHours: 0.0000001,
    keep: 3,
    log,
    checkEveryMs: 3_600_000,
  });
  await new Promise(r => setTimeout(r, 20));
  await s2.runNow();
  s2.stop();
  assert.ok(listBackups(backupDir).length >= 2);

  // A folder that can't be written to.
  const blocker = join(tmp(), "a-file");
  writeFileSync(blocker, "x");
  const s3 = startBackupSchedule({
    db,
    dir: join(blocker, "inside"),
    everyHours: 1,
    keep: 3,
    log,
    checkEveryMs: 3_600_000,
  });
  await s3.runNow();
  s3.stop();
  assert.ok(lines.some(l => l.msg === "backup failed" && l.level === "error"));
});

// ---------------- migrations ----------------

test("migrations: every applied migration records a checksum", async () => {
  const db = openDb(":memory:");
  const rows = /** @type {{ name: string, checksum: string }[]} */ (
    db.prepare("SELECT name, checksum FROM schema_migrations").all()
  );
  assert.ok(rows.length >= 10);
  assert.ok(rows.every(r => /^[0-9a-f]{64}$/.test(r.checksum)));
  db.close();
});

test("migrations: an edited, missing, newer-than-code or out-of-order migration stops the server with a clear reason", async () => {
  const dir = tmp();
  const path = join(dir, "lightlms.sqlite");
  const open = () => openDb(path, { backupDir: null });
  open().close();
  const tamper = sql => {
    const raw = new Database(path);
    raw.exec(sql);
    raw.close();
  };

  tamper("UPDATE schema_migrations SET checksum = '" + "0".repeat(64) + "' WHERE name = '003_enrolment.sql'");
  assert.throws(open, /003_enrolment\.sql was changed after it was applied/);
  tamper("UPDATE schema_migrations SET checksum = NULL WHERE name = '003_enrolment.sql'"); // a pre-checksum database: filled in, trusted once
  open().close();
  const stored = new Database(path)
    .prepare("SELECT checksum FROM schema_migrations WHERE name = '003_enrolment.sql'")
    .pluck()
    .get();
  assert.match(String(stored), /^[0-9a-f]{64}$/);

  tamper(
    "INSERT INTO schema_migrations (name, applied_at, checksum) VALUES ('999_from_the_future.sql', 'x', 'y')",
  );
  assert.throws(open, /999_from_the_future\.sql, which this version of the code doesn't have/);
  tamper("DELETE FROM schema_migrations WHERE name = '999_from_the_future.sql'");

  tamper("DELETE FROM schema_migrations WHERE name = '004_attempts.sql'");
  assert.throws(open, /004_attempts\.sql is new but sorts before one that has already been applied/);
});

test("migrations: a backup is taken before pending ones run on a database that holds data, and not on a fresh one", async () => {
  const dir = tmp();
  const path = join(dir, "lightlms.sqlite");
  const backupDir = join(dir, "backups");
  openDb(path, { backupDir }).close(); // fresh: nothing to protect
  assert.deepEqual(listBackups(backupDir), []);

  // Pretend the newest migration has not run yet, as it wouldn't have on an older version.
  const raw = new Database(path);
  raw.exec("DROP TABLE audit_log; DELETE FROM schema_migrations WHERE name = '010_audit_log.sql'");
  raw.close();
  const log = [];
  const db = openDb(path, { backupDir, log: createLogger({ write: l => log.push(JSON.parse(l)) }) });
  const [safety] = listBackups(backupDir);
  assert.equal(safety.label, "pre-migrate");
  assert.deepEqual((await verifyBackup(join(backupDir, safety.name))).migrations, 9); // as it was before
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'audit_log'").get()); // and now migrated
  assert.ok(log.some(l => l.msg === "backed up before migrating"));
  assert.ok(log.some(l => l.msg === "migration applied" && l.migration === "010_audit_log.sql"));
  db.close();
  openDb(path, { backupDir }).close(); // nothing pending: no new backup
  assert.equal(listBackups(backupDir).length, 1);
});

test("backupSync: a consistent, verified backup without the server running", async () => {
  const { db, backupDir } = await populated(tmp());
  const name = backupSync(db, backupDir, "pre-migrate");
  assert.match(name, BACKUP_NAME);
  assert.equal((await verifyBackup(join(backupDir, name))).users, 1);
  assert.deepEqual(
    readdirSync(backupDir).filter(f => f.startsWith(".tmp") || f.endsWith(".partial")),
    [],
  );
});

// ---------------- the command line, as an operator would use it ----------------

test("command line: backup, list, verify, restore, and a refusal while the server is running", async () => {
  const dir = tmp();
  const env = {
    ...process.env,
    DATABASE_PATH: join(dir, "data", "lightlms.sqlite"),
    BACKUP_DIR: join(dir, "backups"),
    NODE_ENV: "development",
    LOG_LEVEL: "silent",
  };
  const run = (...args) =>
    spawnSync(process.execPath, ["server/backup-cli.js", ...args], { env, encoding: "utf8" });
  openDb(env.DATABASE_PATH, { backupDir: null }).close();

  const made = run("backup");
  assert.equal(made.status, 0, made.stderr);
  assert.match(made.stdout, /Backed up to .*lightlms-\d{8}-\d{6}-\d{3}\.sqlite\.gz/);
  assert.match(made.stdout, /copy it somewhere off this machine/);
  const [{ name }] = listBackups(env.BACKUP_DIR);

  assert.match(run("backups").stdout, new RegExp(name.replace(/\./g, "\\.")));
  assert.match(run("verify-backup", name).stdout, /^OK: .* opens cleanly/);
  writeFileSync(join(env.BACKUP_DIR, "lightlms-20200101-000000-000.sqlite.gz"), "garbage");
  const bad = run("verify-backup", "lightlms-20200101-000000-000.sqlite.gz");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /isn't a usable backup/);

  writeFileSync(`${env.DATABASE_PATH}.lock`, String(process.pid));
  const refused = run("restore", "latest");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /server is running/);
  rmSync(`${env.DATABASE_PATH}.lock`);

  const restored = run("restore", "latest");
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /Restored .*pre-restore/s);
  assert.equal(run("nonsense").status, 1);
});

// ---------------- the admin side ----------------
import { start } from "./helpers.js";
import { openBrowser } from "./browser-helpers.js";
import { backupsView } from "../../public/js/views/manage/backups.js";
import { PW } from "./helpers.js";

const withBackups = (dir = tmp()) =>
  start(undefined, { config: { backupDir: join(dir, "backups"), backupKeep: 3, backupEveryHours: 24 } });

test("admin backups: only admins; make one, see it listed with no server paths, download a copy that verifies", async () => {
  const s = await withBackups();
  const admin = await s.as("admin");
  /** @type {(null | "learner" | "author")[]} */
  const outsiders = [null, "learner", "author"];
  for (const who of outsiders) {
    const call = await s.as(who);
    assert.equal((await call("/api/admin/backups")).status, who ? 403 : 401, `${who} may not list`);
    assert.equal(
      (await call("/api/admin/backups", { method: "POST", body: {} })).status,
      who ? 403 : 401,
      `${who} may not make`,
    );
  }

  assert.deepEqual((await admin("/api/admin/backups")).body, { backups: [], everyHours: 24, keep: 3 });
  const made = await admin("/api/admin/backups", { method: "POST", body: {} });
  assert.equal(made.status, 201);
  assert.match(made.body.name, BACKUP_NAME);

  const list = (await admin("/api/admin/backups")).body;
  assert.equal(list.backups.length, 1);
  assert.ok(!JSON.stringify(list).includes(tmpdir()), "the folder's path must not be sent to the browser");

  const download = await s.raw(`/api/admin/backups/${made.body.name}/download`, { cookie: undefined });
  assert.equal(download.status, 401); // not signed in
  const login = await s.parse(
    await s.raw("/api/auth/login", { method: "POST", body: { email: "admin@example.com", password: PW } }),
  );
  const cookie = login.setCookie.split(";")[0];
  const res = await s.raw(`/api/admin/backups/${made.body.name}/download`, { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/gzip");
  assert.match(res.headers.get("content-disposition"), /attachment; filename="lightlms-/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const file = join(tmp(), "downloaded.sqlite.gz");
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  assert.equal((await verifyBackup(file)).users, 3); // admin, author and learner
  s.close();
});

test("admin backups: names that try to reach other files are refused, and unknown ones are a 404", async () => {
  const s = await withBackups();
  const login = await s.parse(
    await s.raw("/api/auth/login", { method: "POST", body: { email: "admin@example.com", password: PW } }),
  );
  const cookie = login.setCookie.split(";")[0];
  const get = name => s.raw(`/api/admin/backups/${name}/download`, { cookie });
  for (const evil of [
    "..%2F..%2Fetc%2Fpasswd",
    "%2e%2e%2fsecret",
    "lightlms.sqlite",
    "lightlms-20260101-000000-000.sqlite.gz%00.txt",
    "..",
    "lightlms-20260101-000000-000.sqlite.gz/../x",
  ])
    // 400 for a malformed name; ".." is tidied by URL parsing into an unlisted admin route, which is refused with 403.
    assert.ok([400, 403, 404].includes((await get(evil)).status), evil);
  assert.equal((await get("lightlms-20260101-000000-000.sqlite.gz")).status, 404); // well-formed but not there
  s.close();
});

test("admin backups: making one is audited, old ones are pruned, and a server without backups says so", async () => {
  const s = await withBackups();
  const admin = await s.as("admin");
  for (let i = 0; i < 5; i++) await admin("/api/admin/backups", { method: "POST", body: {} });
  assert.equal((await admin("/api/admin/backups")).body.backups.length, 3); // keep: 3
  const login = await s.parse(
    await s.raw("/api/auth/login", { method: "POST", body: { email: "admin@example.com", password: PW } }),
  );
  const cookie = login.setCookie.split(";")[0];
  const name = (await admin("/api/admin/backups")).body.backups[0].name;
  await s.raw(`/api/admin/backups/${name}/download`, { cookie });
  const actions = (await admin("/api/admin/audit?limit=50")).body.entries.map(e => e.action);
  assert.equal(actions.filter(a => a === "backup.created").length, 5);
  assert.equal(actions.filter(a => a === "backup.downloaded").length, 1);
  s.close();

  const bare = await start(); // no backup folder configured
  assert.equal((await (await bare.as("admin"))("/api/admin/backups")).status, 503);
  bare.close();
});

test("browser: the backups page shows what exists, makes a backup on request, and refuses non-admins", async () => {
  const s = await withBackups();
  const b = openBrowser(s);
  try {
    await b.signIn("author@example.com", PW);
    await b.show(backupsView, { user: { role: "author" } });
    assert.match(b.text(), /Only administrators/);

    await b.signIn("admin@example.com", PW);
    await b.show(backupsView, { user: { role: "admin" } });
    await b.until(() => /No backups yet/.test(b.text()), "the empty list");
    assert.match(b.text(), /every 24 hours, and the newest 3 are kept/);
    assert.match(b.text(), /password hashes/); // the warning about what a backup holds
    await b.press("Back up now");
    await b.until(() => /Backup made and checked/.test(b.text()), "the confirmation");
    assert.equal(b.$$("tbody tr").length, 1);
    assert.match(
      b.$("tbody a").getAttribute("href"),
      /^\/api\/admin\/backups\/lightlms-.*\.sqlite\.gz\/download$/,
    );
    await b.settled();
  } finally {
    b.close();
    s.close();
  }
});

// ---------------- the real process ----------------
import { spawn } from "node:child_process";
import { createServer } from "node:net";

/** Asks the system for a port nobody is using. */
const freePort = () =>
  new Promise(resolve => {
    const probe = createServer().listen(0, () => {
      const { port } = /** @type {import("node:net").AddressInfo} */ (probe.address());
      probe.close(() => resolve(port));
    });
  });

test("the real server: starts, makes its first backup, answers health checks, and shuts down cleanly on SIGTERM", async () => {
  const dir = tmp();
  const port = await freePort();
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    DATABASE_PATH: join(dir, "data", "lightlms.sqlite"),
    TRUST_PROXY: "0",
    LOG_LEVEL: "info",
  };
  const child = spawn(process.execPath, ["server/index.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", d => (out += d));
  child.stderr.on("data", d => (out += d));
  const exited = new Promise(resolve => child.on("exit", (code, signal) => resolve({ code, signal })));
  try {
    const health = await (async () => {
      for (let i = 0; i < 100; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/health`);
          if (r.ok) return r.json();
        } catch {
          /* not up yet */
        }
        await new Promise(r => setTimeout(r, 50));
      }
      throw new Error(`the server never came up:\n${out}`);
    })();
    assert.deepEqual([health.ok, health.schema], [true, "010_audit_log.sql"]);
    assert.equal(readFileSync(`${env.DATABASE_PATH}.lock`, "utf8"), String(child.pid)); // the lock names this process
    for (let i = 0; i < 100 && !out.includes("backup made"); i++) await new Promise(r => setTimeout(r, 50));
    assert.match(out, /"msg":"backup made"/);
    assert.equal(listBackups(join(dir, "data", "backups")).length, 1);
    assert.match(out, /"env":"production"/);

    child.kill("SIGTERM");
    const { code } = await exited;
    assert.equal(code, 0, out);
    assert.match(out, /"msg":"shutting down"/);
    assert.match(out, /"msg":"stopped"/);
    assert.ok(!existsSync(`${env.DATABASE_PATH}.lock`), "the lock is released");
    assert.ok(
      !existsSync(`${env.DATABASE_PATH}-wal`) || readFileSync(`${env.DATABASE_PATH}-wal`).length === 0,
      "the journal was merged into the database",
    );
    await restoreBackup({
      file: "latest",
      dbPath: env.DATABASE_PATH,
      backupDir: join(dir, "data", "backups"),
    }); // and it can be restored now it has stopped
  } finally {
    child.kill("SIGKILL");
  }
});
