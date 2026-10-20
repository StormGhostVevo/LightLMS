import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { start, quizCourse, complete, publishedCourse, PW } from "./helpers.js";
import { createLoginThrottle, weakPassword } from "../auth.js";

// ---------------- headers and the content security policy ----------------

test("headers: a strict content security policy, with nothing inline and nothing from elsewhere", async () => {
  const s = await start();
  const res = await s.raw("/", { type: null });
  const csp = Object.fromEntries(
    res.headers
      .get("content-security-policy")
      .split(";")
      .map(d => d.trim().split(/\s+/))
      .map(([name, ...values]) => [name, values]),
  );
  assert.deepEqual(csp["script-src"], ["'self'"]);
  assert.deepEqual(csp["style-src"], ["'self'"]);
  assert.deepEqual(csp["script-src-attr"], ["'none'"]);
  assert.deepEqual(csp["style-src-attr"], ["'none'"]);
  assert.deepEqual(csp["default-src"], ["'self'"]);
  assert.deepEqual(csp["img-src"], ["'self'"]);
  assert.deepEqual(csp["connect-src"], ["'self'"]);
  assert.deepEqual(csp["frame-ancestors"], ["'none'"]);
  assert.deepEqual(csp["object-src"], ["'none'"]);
  assert.deepEqual(csp["base-uri"], ["'self'"]);
  assert.deepEqual(csp["form-action"], ["'self'"]);
  assert.ok(!res.headers.get("content-security-policy").includes("unsafe-inline"));
  assert.ok(!res.headers.get("content-security-policy").includes("unsafe-eval"));
  assert.ok(!/https?:/.test(res.headers.get("content-security-policy")), "no other site is allowed");
  assert.equal(csp["upgrade-insecure-requests"], undefined); // development is plain http
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(res.headers.get("x-powered-by"), null);
  s.close();
});

test("headers: production also upgrades insecure requests and marks the session cookie Secure", async () => {
  const { createApp } = await import("../app.js");
  const { openDb } = await import("../db.js");
  const { track } = await import("./helpers.js");
  const { hashPassword } = await import("../auth.js");
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO users (email, role, password_hash, created_at) VALUES ('a@example.com', 'learner', ?, ?)",
  ).run(await hashPassword(PW), new Date().toISOString());
  const server = track(
    createApp({ db, config: { prod: true, trustProxy: 1 }, ai: { name: "off" } }).listen(0),
  );
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  const res = await fetch(`http://localhost:${port}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "a@example.com", password: PW }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(res.headers.get("content-security-policy"), /upgrade-insecure-requests/);
});

test("headers: API answers are never cached; static files may be", async () => {
  const s = await start();
  const author = await s.as("author");
  assert.equal((await s.raw("/api/courses", { type: null })).headers.get("cache-control"), "no-store");
  assert.equal((await s.raw("/api/auth/me")).headers.get("cache-control"), "no-store"); // even the refusals
  assert.notEqual((await s.raw("/css/app.css", { type: null })).headers.get("cache-control"), "no-store");
  assert.ok(author);
  s.close();
});

test("nothing served uses inline scripts, inline styles or inline event handlers (so the policy can forbid them)", async () => {
  const s = await start();
  const { id, answers } = await quizCourse(s);
  const learner = await s.as("learner");
  await complete(learner, id, answers);
  const code = (await learner(`/api/courses/${id}/certificate`)).body.code;

  const pages = {
    "index.html": readFileSync("public/index.html", "utf8"),
    "certificate page": await (await s.raw(`/certificate/${code}`, { type: null })).text(),
    "certificate not found page": await (await s.raw("/certificate/LL-AAAAA-AAAAA", { type: null })).text(),
  };
  for (const [name, html] of Object.entries(pages)) {
    assert.ok(!/<style[\s>]/i.test(html), `${name} has a <style> block`);
    assert.ok(!/\sstyle\s*=/i.test(html), `${name} has a style attribute`);
    assert.ok(!/\son[a-z]+\s*=/i.test(html), `${name} has an inline event handler`);
    assert.ok(!/<script(?![^>]*\ssrc=)/i.test(html), `${name} has an inline script`);
  }
  // The browser code builds elements itself; it must not set a style attribute or write a style tag.
  const walk = dir =>
    readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    );
  for (const file of walk("public/js")) {
    const src = readFileSync(file, "utf8");
    assert.ok(!/setAttribute\(\s*["']style["']/.test(src), `${file} sets a style attribute`);
    assert.ok(!/<style/i.test(src), `${file} writes a style tag`);
    assert.ok(!/\beval\(|new Function\(/.test(src), `${file} uses eval`);
  }
  s.close();
});

test("static files: only the public folder is served; source, config, data and dotfiles are not", async () => {
  const s = await start();
  for (const path of [
    "/.env",
    "/.git/config",
    "/package.json",
    "/server/app.js",
    "/server/config.js",
    "/data/lightlms.sqlite",
    "/node_modules/express/package.json",
    "/../package.json",
    "/%2e%2e/package.json",
    "/server/migrations/001_init.sql",
    "/docs/ARCHITECTURE.md",
  ]) {
    const r = await s.raw(path, { type: null });
    assert.ok([403, 404].includes(r.status), `${path} returned ${r.status}`);
    assert.equal(
      await r.text(),
      "Not found",
      `${path} should get the same short answer as any unknown address`,
    );
  }
  assert.equal((await s.raw("/css/app.css", { type: null })).status, 200);
  const api = await s.raw("/api/nothing-here", { type: null });
  assert.deepEqual([api.status, await api.json()], [404, { error: "Not found" }]);
  s.close();
});

// ---------------- cross-site requests ----------------

test("origin check: a change that comes from another site is refused; the site's own pages, scripts and reads are fine", async () => {
  const s = await start();
  const cookie = (
    await s.parse(
      await s.raw("/api/auth/login", { method: "POST", body: { email: "author@example.com", password: PW } }),
    )
  ).setCookie.split(";")[0];
  const post = origin =>
    fetch(`${s.base}/api/admin/courses`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, ...(origin === undefined ? {} : { origin }) },
      body: JSON.stringify({ title: "From somewhere" }),
    });
  assert.equal((await post(undefined)).status, 201); // a script or curl: no Origin
  assert.equal((await post(s.base)).status, 201); // the site's own page
  for (const evil of [
    "https://evil.example",
    "http://localhost:1",
    "null",
    "not a url",
    s.base.replace("localhost", "127.0.0.1"),
  ])
    assert.equal((await post(evil)).status, 403, evil);
  // Reading is not blocked by the check (the browser's own rules stop another site reading the answer).
  const get = await fetch(`${s.base}/api/courses`, { headers: { cookie, origin: "https://evil.example" } });
  assert.equal(get.status, 200);
  assert.equal(
    (await (await s.as("author"))("/api/admin/courses")).body.filter(c => c.title === "From somewhere")
      .length,
    2,
  ); // only the two allowed ones were made
  s.close();
});

// ---------------- guessing passwords ----------------

test("login throttle: after ten failures an account refuses sign-in, from any address, even with the right password", async () => {
  const s = await start(undefined, { config: { trustProxy: 1 } });
  const from = (ip, email, password) =>
    fetch(`${s.base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ email, password }),
    }).then(r => r.status);
  for (let i = 0; i < 10; i++)
    assert.equal(await from(`198.51.100.${i}`, "learner@example.com", "wrong-wrong-wrong"), 401); // ten different machines
  assert.equal(await from("198.51.100.99", "learner@example.com", PW), 429); // the right password is refused too
  assert.equal(await from("198.51.100.99", "LEARNER@example.com", PW), 429); // case doesn't dodge it
  assert.equal(await from("198.51.100.99", "author@example.com", PW), 200); // other accounts are untouched
  s.close();
});

test("login throttle: unknown emails are counted the same way, so the answer never says which accounts exist", async () => {
  const s = await start(undefined, { config: { trustProxy: 1 } });
  const reply = async (ip, email) => {
    const r = await fetch(`${s.base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ email, password: "wrong-wrong-wrong" }),
    });
    return [r.status, (await r.json()).error];
  };
  for (let i = 0; i < 10; i++) {
    await reply(`198.51.100.${i}`, "learner@example.com");
    await reply(`198.51.101.${i}`, "nobody@example.com");
  }
  assert.deepEqual(
    await reply("198.51.102.1", "learner@example.com"),
    await reply("198.51.102.2", "nobody@example.com"),
  );
  s.close();
});

test("login throttle: a success clears the count, and the lock ends when the window passes", () => {
  let t = 0;
  const throttle = createLoginThrottle({ limit: 3, windowMs: 1000, clock: () => t });
  for (let i = 0; i < 2; i++) throttle.fail("a");
  assert.equal(throttle.locked("a"), false);
  throttle.clear("a"); // they signed in
  for (let i = 0; i < 2; i++) throttle.fail("a");
  assert.equal(throttle.locked("a"), false); // starts again from zero
  throttle.fail("a");
  assert.equal(throttle.locked("a"), true);
  assert.equal(throttle.locked("b"), false);
  t = 1001; // the window passes
  assert.equal(throttle.locked("a"), false);
  throttle.fail("a");
  assert.equal(throttle.locked("a"), false); // one failure, a fresh count
});

test("login throttle: memory stays bounded however many different emails are tried", () => {
  const throttle = createLoginThrottle({ limit: 3, windowMs: 3_600_000 });
  for (let i = 0; i < 60_000; i++) throttle.fail(`person${i}@example.com`);
  assert.equal(throttle.locked("person59999@example.com"), false); // still working, and it didn't run out of memory
});

test("passwords: common, repeated and email-based passwords are refused; ordinary good ones are accepted", async () => {
  for (const weak of [
    "password1234",
    "Password1234",
    "1234567890",
    "aaaaaaaaaaaa",
    "passwordforme",
    "qwertyuiop",
  ])
    assert.ok(weakPassword(weak, "sam@example.com"), weak);
  assert.ok(weakPassword("my-sam-secret-1", "sam.smith@example.com") === null); // "sam" is too short to count
  assert.ok(weakPassword("xx-samsmith-xx", "samsmith@example.com"));
  assert.equal(weakPassword("correct-horse-battery", "sam@example.com"), null);

  const s = await start();
  const learner = await s.as("learner");
  const change = next => learner("/api/auth/password", { method: "POST", body: { current: PW, next } });
  assert.equal((await change("password1234")).status, 400);
  assert.match((await change("password1234")).body.error, /too easy to guess/);
  assert.equal((await change("learner-learner-1")).status, 400); // contains their email name
  assert.equal((await change("a-fine-new-passphrase")).status, 204);
  s.close();
});

// ---------------- general ----------------

test("rate limit: one visitor cannot flood the API", async () => {
  const s = await start();
  let limited = null;
  for (let i = 0; i < 650 && !limited; i++) {
    const r = await s.raw("/api/auth/me", { type: null });
    if (r.status === 429) limited = await r.json();
  }
  assert.match(limited?.error ?? "", /Too many requests/);
  s.close();
});

test("secrets never appear in API answers: no password hashes, no session ids", async () => {
  const s = await start();
  const admin = await s.as("admin");
  const everything = JSON.stringify([
    (await admin("/api/admin/users")).body,
    (await admin("/api/auth/me")).body,
    (await admin("/api/admin/audit?limit=50")).body,
    (await (await s.as("author"))("/api/admin/courses")).body,
  ]);
  for (const secret of ["scrypt$", "password_hash", "id_hash", "passwordHash"])
    assert.ok(!everything.includes(secret), secret);
  s.close();
});

test("learners cannot read each other's attempts, certificates lists, or progress", async () => {
  const s = await start();
  const { author, id, answers } = await quizCourse(s);
  const learner = await s.as("learner");
  const attempt = (
    await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: answers(0) } })
  ).body.id;
  assert.equal((await learner(`/api/attempts/${attempt}`)).status, 200);
  assert.equal((await author(`/api/attempts/${attempt}`)).status, 404); // staff have their own, permissioned route for this
  const { id: other } = await publishedCourse(s);
  assert.equal((await learner(`/api/courses/${other}`)).status, 404); // not enrolled: looks like it doesn't exist
  assert.equal((await learner(`/api/courses/${other}/progress`)).status, 404);
  s.close();
});
