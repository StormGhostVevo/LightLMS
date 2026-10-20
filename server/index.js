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
holdLock(config.dbPath);
const app = createApp({ db, config, ai: makeAi(config), log });

// Sessions are removed when they are used after expiring, but most are simply abandoned, so sweep them out regularly.
const sweep = () => {
  const removed = purgeExpiredSessions(db);
  if (removed) log.info("expired sessions removed", { removed });
};
sweep();
setInterval(sweep, 60 * 60 * 1000).unref();

if (config.backupEveryHours > 0)
  startBackupSchedule({
    db,
    dir: config.backupDir,
    everyHours: config.backupEveryHours,
    keep: config.backupKeep,
    log,
  });
else log.warn("scheduled backups are switched off");

app.listen(config.port, () =>
  log.info("listening", {
    port: config.port,
    ai: config.ai.provider,
    env: config.prod ? "production" : "development",
  }),
);
