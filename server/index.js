import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { makeAi } from "./ai.js";
import { createApp } from "./app.js";

const config = loadConfig();
const app = createApp({ db: openDb(config.dbPath), config, ai: makeAi(config) });
app.listen(config.port, () => console.log(`lightlms on http://localhost:${config.port} (AI: ${config.ai.provider})`));
