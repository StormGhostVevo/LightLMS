import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { createBackup, listBackups, pruneBackups, restoreBackup, verifyBackup } from "./backup.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

// npm run backup                 make a verified backup now
// npm run backups                list them
// npm run verify-backup -- FILE  check that a backup can be opened (FILE may be a name in the backups folder)
// npm run restore -- FILE        replace the database with a backup (stop the server first). FILE may be "latest"
const [cmd, arg] = process.argv.slice(2);
const config = loadConfig();
const mb = n => `${(n / 1024 / 1024).toFixed(1)} MB`;

try {
  if (cmd === "backup") {
    const db = openDb(config.dbPath, { backupDir: config.backupDir });
    const b = await createBackup(db, config.backupDir);
    const removed = pruneBackups(config.backupDir, { keep: config.backupKeep });
    console.log(
      `Backed up to ${join(config.backupDir, b.name)} (${mb(b.bytes)}; ${b.users} users, ${b.courses} courses).`,
    );
    if (removed.length)
      console.log(`Removed ${removed.length} old backup${removed.length === 1 ? "" : "s"}.`);
    console.log("Remember to copy it somewhere off this machine too.");
  } else if (cmd === "backups") {
    const all = listBackups(config.backupDir);
    if (!all.length) console.log(`No backups in ${config.backupDir}.`);
    for (const b of all)
      console.log(
        `${b.name.padEnd(56)} ${mb(b.bytes).padStart(9)}  ${b.createdAt}${b.label ? `  (${b.label})` : ""}`,
      );
  } else if (cmd === "verify-backup") {
    if (!arg) throw new Error("Usage: npm run verify-backup -- <file>");
    const path = existsSync(arg) ? arg : join(config.backupDir, arg);
    const info = await verifyBackup(path);
    console.log(
      `OK: ${path} opens cleanly. It holds ${info.users} users and ${info.courses} courses (${info.migrations} migrations).`,
    );
  } else if (cmd === "restore") {
    if (!arg) throw new Error('Usage: npm run restore -- <file or "latest">');
    const r = await restoreBackup({ file: arg, dbPath: config.dbPath, backupDir: config.backupDir });
    console.log(`Restored ${r.restoredFrom} (${r.users} users, ${r.courses} courses).`);
    if (r.safetyCopy)
      console.log(`What was there before is kept as ${join(config.backupDir, r.safetyCopy)}.`);
    console.log(
      "Start the server again. Any newer migrations are applied (with a backup first) when it starts.",
    );
  } else {
    throw new Error(
      "Usage: node server/backup-cli.js backup | backups | verify-backup <file> | restore <file|latest>",
    );
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
