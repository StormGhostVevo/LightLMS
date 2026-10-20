import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../db.js";
import { createApp } from "../app.js";
import { createSession, purgeExpiredSessions } from "../auth.js";
import { loadConfig } from "../config.js";
import { stubProvider } from "../ai.js";
import { start, PW, track } from "./helpers.js";

test("login: wrong password and unknown email get the same answer; cookie is httpOnly", async () => {
  const s = await start();
  const wrong = await s.parse(
    await s.raw("/api/auth/login", {
      method: "POST",
      body: { email: "learner@example.com", password: "nope-nope-nope" },
    }),
  );
  const unknown = await s.parse(
    await s.raw("/api/auth/login", {
      method: "POST",
      body: { email: "ghost@example.com", password: "nope-nope-nope" },
    }),
  );
  assert.deepEqual([wrong.status, wrong.body], [unknown.status, unknown.body]);
  const ok = await s.parse(
    await s.raw("/api/auth/login", { method: "POST", body: { email: "LEARNER@example.com", password: PW } }),
  );
  assert.equal(ok.status, 200);
  assert.match(ok.setCookie, /HttpOnly/);
  assert.match(ok.setCookie, /SameSite=Lax/);
  const row = /** @type {{ id_hash: string }} */ (s.db.prepare("SELECT id_hash FROM sessions").get());
  assert.ok(!ok.setCookie.includes(row.id_hash)); // the database holds a hash, not the cookie value
});

test("logout ends the session; writes without a JSON content type are refused", async () => {
  const s = await start();
  const login = await s.parse(
    await s.raw("/api/auth/login", { method: "POST", body: { email: "learner@example.com", password: PW } }),
  );
  const cookie = login.setCookie.split(";")[0];
  assert.equal((await s.parse(await s.raw("/api/auth/me", { cookie }))).status, 200);
  assert.equal((await s.raw("/api/auth/logout", { method: "POST", cookie, type: "text/plain" })).status, 415);
  assert.equal((await s.raw("/api/auth/logout", { method: "POST", cookie })).status, 204);
  assert.equal((await s.parse(await s.raw("/api/auth/me", { cookie }))).status, 401);
});

test("admin creates users; only admins can; deactivating ends their sessions; last admin is protected", async () => {
  const s = await start();
  const admin = await s.as("admin"),
    author = await s.as("author"),
    learner = await s.as("learner");
  assert.equal((await author("/api/admin/users")).status, 403);
  const made = await admin("/api/admin/users", {
    method: "POST",
    body: { email: "new@example.com", role: "author" },
  });
  assert.equal(made.status, 201);
  assert.ok(made.body.temporaryPassword.length >= 10);
  assert.equal(
    (await admin("/api/admin/users", { method: "POST", body: { email: "NEW@example.com" } })).status,
    409,
  );
  assert.equal(
    (await admin("/api/admin/users", { method: "POST", body: { email: "x@example.com", role: "root" } }))
      .status,
    400,
  );
  const learnerId = s.db.prepare("SELECT id FROM users WHERE email = 'learner@example.com'").pluck().get();
  await admin(`/api/admin/users/${learnerId}`, { method: "PATCH", body: { active: false } });
  assert.equal((await learner("/api/auth/me")).status, 401);
  const adminId = s.db.prepare("SELECT id FROM users WHERE email = 'admin@example.com'").pluck().get();
  assert.equal(
    (await admin(`/api/admin/users/${adminId}`, { method: "PATCH", body: { role: "learner" } })).status,
    409,
  );
  s.close();
});

test("changing password needs the current one and ends other sessions", async () => {
  const s = await start();
  const a = await s.as("learner"),
    b = await s.as("learner");
  assert.equal(
    (
      await a("/api/auth/password", {
        method: "POST",
        body: { current: "wrong-wrong-wrong", next: "a-new-long-password" },
      })
    ).status,
    401,
  );
  assert.equal(
    (await a("/api/auth/password", { method: "POST", body: { current: PW, next: "short" } })).status,
    400,
  );
  assert.equal(
    (await a("/api/auth/password", { method: "POST", body: { current: PW, next: "a-new-long-password" } }))
      .status,
    204,
  );
  assert.equal((await b("/api/auth/me")).status, 401); // the other session was ended
  const again = await s.parse(
    await s.raw("/api/auth/login", {
      method: "POST",
      body: { email: "learner@example.com", password: "a-new-long-password" },
    }),
  );
  assert.equal(again.status, 200);
});

test("a temporary password must be replaced before anything else works", async () => {
  const s = await start();
  const admin = await s.as("admin");
  const made = (await admin("/api/admin/users", { method: "POST", body: { email: "fresh@example.com" } }))
    .body;
  const login = await s.parse(
    await s.raw("/api/auth/login", {
      method: "POST",
      body: { email: "fresh@example.com", password: made.temporaryPassword },
    }),
  );
  assert.equal(login.body.mustChangePassword, true);
  const fresh = (path, opts = {}) =>
    s.raw(path, { ...opts, cookie: login.setCookie.split(";")[0] }).then(s.parse);
  const blocked = await fresh("/api/courses");
  assert.deepEqual([blocked.status, blocked.body.mustChangePassword], [403, true]);
  assert.equal((await fresh("/api/auth/me")).status, 200); // still allowed
  const changed = await fresh("/api/auth/password", {
    method: "POST",
    body: { current: made.temporaryPassword, next: "my-own-long-password" },
  });
  assert.equal(changed.status, 204);
  assert.equal((await fresh("/api/courses")).status, 401); // the old session was ended
  const next = await s.parse(await s.raw("/api/courses", { cookie: changed.setCookie.split(";")[0] }));
  assert.equal(next.status, 200); // the new one works
  s.close();
});

test("config: sensible defaults, production defaults, and clear errors for bad values", () => {
  const dev = loadConfig({}, {});
  assert.deepEqual(
    [dev.prod, dev.port, dev.ai.provider, dev.trustProxy, dev.timeZone],
    [false, 3000, "stub", 0, "Australia/Sydney"],
  );
  const prod = loadConfig({}, { NODE_ENV: "production" });
  assert.deepEqual([prod.prod, prod.ai.provider, prod.trustProxy], [true, "off", 1]); // AI off and one proxy trusted in production
  assert.equal(loadConfig({}, { NODE_ENV: "production", TRUST_PROXY: "0" }).trustProxy, 0);
  assert.equal(loadConfig({}, { PORT: "" }).port, 3000); // empty counts as not set
  assert.equal(loadConfig({ port: 1 }, {}).port, 1); // explicit overrides win
  for (const env of [
    { PORT: "banana" },
    { PORT: "70000" },
    { TIMEZONE: "Mars/Olympus" },
    { AI_PROVIDER: "gpt" },
    { TRUST_PROXY: "-1" },
    { ORG_NAME: "x".repeat(61) },
  ])
    assert.throws(() => loadConfig({}, env), /Invalid configuration/, JSON.stringify(env));
  assert.throws(() => loadConfig({}, { AI_PROVIDER: "anthropic" }), /ANTHROPIC_API_KEY/);
  assert.equal(loadConfig({}, { AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" }).ai.provider, "anthropic");
});

test("sessions: expired ones are swept out, live ones are kept", async () => {
  const s = await start();
  const uid = s.db.prepare("SELECT id FROM users WHERE email = 'learner@example.com'").pluck().get();
  createSession(s.db, uid); // live
  const stale = createSession(s.db, uid);
  s.db
    .prepare("UPDATE sessions SET expires_at = ? WHERE id_hash != (SELECT id_hash FROM sessions LIMIT 1)")
    .run(new Date(Date.now() - 1000).toISOString());
  assert.equal(s.db.prepare("SELECT COUNT(*) FROM sessions").pluck().get(), 2);
  assert.equal(purgeExpiredSessions(s.db), 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) FROM sessions").pluck().get(), 1);
  assert.equal(purgeExpiredSessions(s.db), 0);
  assert.ok(stale);
  s.close();
});

test("proxy: with one trusted proxy the rate limit counts each visitor separately; without it they share a limit", async () => {
  const tries = async trustProxy => {
    const db = openDb(":memory:");
    const server = createApp({ db, config: { trustProxy }, ai: stubProvider() }).listen(0);
    track(server);
    const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
    const url = `http://localhost:${port}/api/auth/login`;
    const attempt = ip =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ email: "a@b.co", password: "x" }),
      }).then(r => r.status);
    for (let i = 0; i < 10; i++) await attempt("203.0.113.1"); // one visitor uses up their ten attempts
    return { sameVisitor: await attempt("203.0.113.1"), otherVisitor: await attempt("203.0.113.2") };
  };
  assert.deepEqual(await tries(1), { sameVisitor: 429, otherVisitor: 401 }); // others are unaffected
  assert.deepEqual(await tries(0), { sameVisitor: 429, otherVisitor: 429 }); // everyone shares one address
});
