import express from "express";
import { rateLimit } from "express-rate-limit";
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export const ROLES = ["admin", "author", "learner"];
export const MIN_PASSWORD = 10;

const now = () => new Date().toISOString();
const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });
const sha = s => createHash("sha256").update(s).digest("hex");

// ---- passwords: scrypt, stored as "scrypt$<salt>$<hash>" ----
export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}
export async function verifyPassword(pw, stored) {
  const [kind, salt, hash] = String(stored).split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const key = await scrypt(pw, Buffer.from(salt, "hex"), 64);
  const want = Buffer.from(hash, "hex");
  return key.length === want.length && timingSafeEqual(key, want);
}
// Checked when the email is unknown, so a missing account takes as long as a wrong password.
const DUMMY_HASH = await hashPassword("not-a-real-password");

export const newPassword = () => randomBytes(12).toString("base64url");
export const validEmail = e => typeof e === "string" && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// ---- sessions ----
export function createSession(db, userId) {
  const id = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(sha(id), userId, now(), new Date(Date.now() + SESSION_MS).toISOString());
  return id;
}
export const endSession = (db, id) => db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha(id));
export const endUserSessions = (db, userId) => db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);

function readCookie(req, name) {
  for (const part of (req.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
const setCookie = (res, value, { secure, maxAge }) =>
  res.append("Set-Cookie", `sid=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`);

// Attaches req.user (or null). Inactive users and expired sessions never authenticate.
export function sessionMiddleware(db) {
  return (req, res, next) => {
    req.user = null;
    const sid = readCookie(req, "sid");
    if (sid) {
      const row = db.prepare(`SELECT u.id, u.email, u.name, u.role, u.must_change_password, s.expires_at FROM sessions s
                              JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND u.active = 1`).get(sha(sid));
      if (row && row.expires_at > now()) { req.user = row; req.sid = sid; }
      else if (row) endSession(db, sid);
    }
    next();
  };
}

export const requireLogin = (req, res, next) =>
  req.user ? next() : bad(res, "Please sign in", 401);
export const requireRole = (...roles) => (req, res, next) =>
  !req.user ? bad(res, "Please sign in", 401) : roles.includes(req.user.role) ? next() : bad(res, "You don't have access to that", 403);

// Cross-site form posts can't set a JSON content type, so requiring it on writes blocks CSRF alongside SameSite=Lax.
export const jsonOnly = (req, res, next) =>
  ["GET", "HEAD", "OPTIONS"].includes(req.method) || req.is("application/json") ? next() : bad(res, "Send JSON", 415);

const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, mustChangePassword: !!u.must_change_password });

export function authRouter({ db, config }) {
  const r = express.Router();
  const cookieOpts = { secure: config.prod };
  const loginLimit = rateLimit({ windowMs: 10 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false,
    message: { error: "Too many sign-in attempts. Try again in a few minutes." } });

  r.post("/login", loginLimit, async (req, res) => {
    const { email, password } = req.body || {};
    if (typeof email !== "string" || typeof password !== "string") return bad(res, "Email and password are required");
    const u = db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim());
    const ok = await verifyPassword(password, u ? u.password_hash : DUMMY_HASH);
    if (!u || !ok || !u.active) return bad(res, "Wrong email or password", 401);
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now(), u.id);
    setCookie(res, createSession(db, u.id), { ...cookieOpts, maxAge: SESSION_MS / 1000 });
    res.json(publicUser(u));
  });

  r.post("/logout", (req, res) => {
    if (req.sid) endSession(db, req.sid);
    setCookie(res, "", { ...cookieOpts, maxAge: 0 });
    res.status(204).end();
  });

  r.get("/me", requireLogin, (req, res) => res.json(publicUser(req.user)));

  // Changing a password ends every session, then signs this browser back in.
  r.post("/password", requireLogin, loginLimit, async (req, res) => {
    const { current, next: pw } = req.body || {};
    if (typeof current !== "string" || typeof pw !== "string") return bad(res, "Send the current and new password");
    if (pw.length < MIN_PASSWORD) return bad(res, `The new password needs at least ${MIN_PASSWORD} characters`);
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
    if (!(await verifyPassword(current, u.password_hash))) return bad(res, "The current password is wrong", 401);
    const hash = await hashPassword(pw);
    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(hash, u.id);
    endUserSessions(db, u.id);
    setCookie(res, createSession(db, u.id), { ...cookieOpts, maxAge: SESSION_MS / 1000 });
    res.status(204).end();
  });
  return r;
}

// Admin-only user management. Passwords are generated here and shown once; the admin passes them on.
export function usersRouter({ db }) {
  const r = express.Router();
  const get = id => db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  const activeAdmins = () => db.prepare("SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1").pluck().get();

  r.get("/", (req, res) => res.json(db.prepare("SELECT id, email, name, role, active, created_at, last_login_at FROM users ORDER BY email").all()));

  r.post("/", async (req, res) => {
    const { email, name = "", role = "learner" } = req.body || {};
    if (!validEmail(email)) return bad(res, "Enter a valid email address");
    if (!ROLES.includes(role)) return bad(res, "Role must be admin, author or learner");
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email.trim())) return bad(res, "That email already has an account", 409);
    const temp = newPassword();
    const { lastInsertRowid } = db.prepare(`INSERT INTO users (email, name, role, password_hash, must_change_password, created_at) VALUES (?, ?, ?, ?, 1, ?)`)
      .run(email.trim(), String(name).slice(0, 200), role, await hashPassword(temp), now());
    res.status(201).json({ id: lastInsertRowid, email: email.trim(), role, temporaryPassword: temp });
  });

  r.patch("/:id", async (req, res) => {
    const u = get(req.params.id);
    if (!u) return bad(res, "User not found", 404);
    const b = req.body || {};
    const role = b.role ?? u.role, active = b.active === undefined ? !!u.active : !!b.active;
    if (!ROLES.includes(role)) return bad(res, "Role must be admin, author or learner");
    const losesAdmin = u.role === "admin" && u.active && (role !== "admin" || !active);
    if (losesAdmin && activeAdmins() <= 1) return bad(res, "There must be at least one active admin", 409);
    db.prepare("UPDATE users SET role = ?, active = ?, name = ? WHERE id = ?").run(role, active ? 1 : 0, b.name === undefined ? u.name : String(b.name).slice(0, 200), u.id);
    if (!active || role !== u.role) endUserSessions(db, u.id);
    let temporaryPassword;
    if (b.resetPassword) {
      temporaryPassword = newPassword();
      db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?").run(await hashPassword(temporaryPassword), u.id);
      endUserSessions(db, u.id);
    }
    res.json({ id: u.id, role, active, ...(temporaryPassword ? { temporaryPassword } : {}) });
  });
  return r;
}
