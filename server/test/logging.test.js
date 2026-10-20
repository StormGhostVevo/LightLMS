import { test } from "node:test";
import assert from "node:assert/strict";
import { start, quizCourse, complete, PW } from "./helpers.js";
import { createLogger, safePath } from "../logger.js";

/** A logger that keeps what it writes, so a test can read it. */
/** @param {"silent" | "error" | "warn" | "info" | "debug"} [level] */
const capture = (level = "info") => {
  const lines = [];
  return {
    lines,
    log: createLogger({ level, write: l => lines.push(l) }),
    parsed: () => lines.map(l => JSON.parse(l)),
  };
};

test("logger: one JSON object per line, filtered by level, with child fields", () => {
  const c = capture("warn");
  c.log.debug("no");
  c.log.info("no");
  c.log.warn("careful", { thing: 1 });
  c.log.child({ req: "abc" }).error("broken", { n: 2 });
  const [warn, error] = c.parsed();
  assert.deepEqual([warn.level, warn.msg, warn.thing], ["warn", "careful", 1]);
  assert.deepEqual([error.level, error.req, error.n], ["error", "abc", 2]);
  assert.match(warn.t, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(c.lines.length, 2);
  const quiet = capture("silent");
  quiet.log.error("x");
  assert.equal(quiet.lines.length, 0);
});

test("logger: secrets are replaced even if a caller passes them by mistake; errors keep their stack", () => {
  const c = capture();
  c.log.info("oops", {
    password: "hunter2",
    nested: { sessionId: "abc", cookie: "sid=1", fine: "ok" },
    headers: { authorization: "Bearer x" },
    apiKey: "sk-123",
    err: new Error("bad thing"),
  });
  const line = c.parsed()[0];
  assert.equal(line.password, "[redacted]");
  assert.deepEqual(line.nested, { sessionId: "[redacted]", cookie: "[redacted]", fine: "ok" });
  assert.equal(line.headers.authorization, "[redacted]");
  assert.equal(line.apiKey, "[redacted]");
  assert.equal(line.err.message, "bad thing");
  assert.match(line.err.stack, /bad thing/);
  for (const secret of ["hunter2", "sk-123", "sid=1", "Bearer x"])
    assert.ok(!c.lines[0].includes(secret), secret);
});

test("logger: addresses that contain a secret are hidden", () => {
  assert.equal(safePath("/certificate/LL-ABCDE-FGHJK"), "/certificate/:code");
  assert.equal(safePath("/media/AbC123xyz"), "/media/:key");
  assert.equal(safePath("/api/verify/LL-ABCDE-FGHJK"), "/api/verify/:code");
  assert.equal(safePath("/api/courses/4"), "/api/courses/4");
});

test("requests: each gets an id that is returned and logged; bodies, cookies, queries and passwords are never logged", async () => {
  const c = capture();
  const s = await start(undefined, { log: c.log });
  const login = await s.raw("/api/auth/login", {
    method: "POST",
    body: { email: "learner@example.com", password: PW },
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const id = login.headers.get("x-request-id");
  assert.match(id, /^[0-9a-f]{12}$/);

  await s.raw("/api/auth/login", {
    method: "POST",
    body: { email: "learner@example.com", password: "wrong-wrong-wrong" },
  });
  await s.raw("/api/courses?token=super-secret-query", { cookie });
  await s.raw("/health");
  const lines = c.parsed();
  const first = lines.find(l => l.req === id);
  assert.deepEqual([first.method, first.path, first.status], ["POST", "/api/auth/login", 200]);
  assert.ok(typeof first.ms === "number" && typeof first.user === "undefined"); // not signed in yet when it began
  const courses = lines.find(l => l.path === "/api/courses");
  assert.equal(courses.status, 200);
  assert.equal(typeof courses.user, "number"); // who, by id only
  assert.ok(!lines.some(l => l.path === "/health"), "health checks are not logged");

  const everything = c.lines.join("\n");
  for (const secret of [
    PW,
    "wrong-wrong-wrong",
    "super-secret-query",
    cookie.split("=")[1],
    "learner@example.com",
    "127.0.0.1",
    "::1",
  ])
    assert.ok(!everything.includes(secret), `leaked ${secret}`);
  s.close();
});

test("requests: certificate and image addresses are logged without their secret part", async () => {
  const c = capture("debug"); // static files are only logged at debug
  const s = await start(undefined, { log: c.log });
  const { author, id, answers } = await quizCourse(s);
  const learner = await s.as("learner");
  await complete(learner, id, answers);
  const code = (await learner(`/api/courses/${id}/certificate`)).body.code;
  await s.raw(`/certificate/${code}`);
  await s.raw(`/api/verify/${code}`);
  assert.ok(author);
  const everything = c.lines.join("\n");
  assert.ok(!everything.includes(code), "a certificate code leaked into the log");
  assert.ok(c.parsed().some(l => l.path === "/certificate/:code"));
  s.close();
});

test("errors: an unexpected failure is logged in full with the request id, and the person sees only a reference", async () => {
  const c = capture();
  const broken = {
    name: "x",
    draftCourse: async () => Promise.reject(new Error("kaboom with internal detail")),
  };
  const s = await start(broken, { log: c.log });
  const author = await s.as("author");
  const res = await author("/api/admin/ai/draft-course", {
    method: "POST",
    body: { text: "word ".repeat(40) },
  });
  assert.equal(res.status, 500);
  assert.match(res.body.error, /^Something went wrong \(reference [0-9a-f]{12}\)$/);
  assert.ok(!JSON.stringify(res.body).includes("kaboom"), "the detail must not reach the browser");
  const ref = /reference ([0-9a-f]+)/.exec(res.body.error)[1];
  const failure = c.parsed().find(l => l.msg === "unhandled error");
  assert.equal(failure.req, ref);
  assert.match(failure.err.stack, /kaboom with internal detail/);
  assert.equal(c.parsed().find(l => l.msg === "request" && l.status === 500).level, "error");
  s.close();
});
