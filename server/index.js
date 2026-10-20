import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { makeAi } from "./ai.js";
import { createApp } from "./app.js";
import { createLogger } from "./logger.js";
import { purgeExpiredSessions } from "./auth.js";
import { holdLock, startBackupSchedule } from "./backup.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const log = createLogger({ level: config.logLevel });
const db = openDb(config.dbPath, { backupDir: config.backupDir, log });
const releaseLock = holdLock(config.dbPath);
const app = createApp({ db, config, ai: makeAi(config), log });

// Sessions are removed when they are used after expiring, but most are simply abandoned, so sweep them out regularly.
const sweep = () => {
  const removed = purgeExpiredSessions(db);
  if (removed) log.info("expired sessions removed", { removed });
};
sweep();
setInterval(sweep, 60 * 60 * 1000).unref();

let schedule = null;
if (config.backupEveryHours > 0)
  schedule = startBackupSchedule({
    db,
    dir: config.backupDir,
    everyHours: config.backupEveryHours,
    keep: config.backupKeep,
    log,
  });
else log.warn("scheduled backups are switched off");

const server = app.listen(config.port, () =>
  log.info("listening", {
    port: config.port,
    ai: config.ai.provider,
    env: config.prod ? "production" : "development",
  }),
);

// A platform stops a container with SIGTERM. Stop taking new requests, let the ones in flight finish (up to 10 seconds),
// then close the database so its journal is merged into the main file, and release the lock.
let stopping = false;
const shutdown = signal => {
  if (stopping) return;
  stopping = true;
  log.info("shutting down", { signal });
  schedule?.stop();
  const force = setTimeout(() => {
    log.warn("shutdown took too long; forcing exit");
    db.close();
    releaseLock();
    process.exit(1);
  }, 10_000);
  force.unref();
  server.close(() => {
    db.close();
    releaseLock();
    log.info("stopped");
    process.exit(0);
  });
  server.closeIdleConnections();
};
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => shutdown(signal));
