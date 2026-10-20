import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { createPrivacy } from "./services/privacy.js";

// npm run export-user -- <email>          prints everything held about a person, as JSON
// npm run erase-user -- <email> --yes     erases them (without --yes it only says what it would do)
const [cmd, email, flag] = process.argv.slice(2);
try {
  if (!["export", "erase"].includes(cmd) || !email)
    throw new Error("Usage: node server/privacy-cli.js export|erase <email> [--yes]");
  const config = loadConfig();
  const db = openDb(config.dbPath, { backupDir: config.backupDir });
  const privacy = createPrivacy(db);
  if (cmd === "export") {
    console.log(JSON.stringify(privacy.exportPerson(email), null, 2));
  } else if (flag !== "--yes") {
    const data = privacy.exportPerson(email);
    console.log(
      `This would erase ${email}: ${data.enrolments.length} enrolments, ${data.lessonsMarkedDone.length} lesson ticks, ${data.quizAttempts.length} quiz attempts and the account itself.\n` +
        `${data.certificates.length} certificate(s) stay valid but lose the person's name. Earlier backups still hold the old data until they are rotated out.\n` +
        "Run it again with --yes to go ahead. It cannot be undone.",
    );
  } else {
    const r = privacy.erasePerson(email, { allowSelf: true });
    db.prepare(
      "INSERT INTO audit_log (at, actor_email, action, target_type, target_id, target_label, detail) VALUES (?, 'command line', 'user.erased', 'user', ?, ?, ?)",
    ).run(new Date().toISOString(), String(r.id), privacy.erasedEmail(r.id), JSON.stringify(r.removed));
    console.log(`Erased person ${r.id}. Removed:`, JSON.stringify(r.removed));
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
