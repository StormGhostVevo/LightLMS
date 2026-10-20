import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { makeAi } from "./ai.js";
import { createApp } from "./app.js";
import { purgeExpiredSessions } from "./auth.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const db = openDb(config.dbPath);
const app = createApp({ db, config, ai: makeAi(config) });

// Sessions are removed when they are used after expiring, but most are simply abandoned, so sweep them out regularly.
const sweep = () => {
  const n = purgeExpiredSessions(db);
  if (n) console.log(`Removed ${n} expired session${n === 1 ? "" : "s"}`);
};
sweep();
setInterval(sweep, 60 * 60 * 1000).unref();

app.listen(config.port, () =>
  console.log(`lightlms on http://localhost:${config.port} (AI: ${config.ai.provider})`),
);
