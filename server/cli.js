import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { hashPassword, newPassword, validEmail, ROLES } from "./auth.js";

// npm run create-user -- <email> [admin|author|learner]
// Creates the account with a generated password (printed once). Use it to make the first admin.
const [cmd, email, role = "admin"] = process.argv.slice(2);
if (cmd !== "create-user" || !validEmail(email) || !ROLES.includes(role)) {
  console.error("Usage: npm run create-user -- <email> [admin|author|learner]");
  process.exit(1);
}
const db = openDb(loadConfig().dbPath);
if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) {
  console.error("That email already has an account.");
  process.exit(1);
}
const pw = newPassword();
db.prepare(
  "INSERT INTO users (email, role, password_hash, must_change_password, created_at) VALUES (?, ?, ?, 1, ?)",
).run(email, role, await hashPassword(pw), new Date().toISOString());
console.log(`Created ${role} ${email}\nTemporary password (shown once): ${pw}`);
