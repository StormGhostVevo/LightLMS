import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../db.js";
import { createApp } from "../app.js";
import { hashPassword } from "../auth.js";
import { stubProvider, tidyQuestions, cleanBody } from "../ai.js";

const TOKEN = "test-token-test-token-1234";
const SOURCE = "Safety basics\n\nAlways wear a helmet on site.\n\nReport hazards to your supervisor straight away.\n\nKeep walkways clear at all times.";

const servers = [];
after(() => servers.forEach(s => { s.closeAllConnections(); s.close(); }));

const PW = "correct-horse-battery";

// Starts an app with an admin, an author and a learner already created.
async function start(ai = stubProvider()) {
  const db = openDb(":memory:");
  const hash = await hashPassword(PW);
  for (const role of ["admin", "author", "learner"])
    db.prepare("INSERT INTO users (email, role, password_hash, created_at) VALUES (?, ?, ?, ?)").run(`${role}@example.com`, role, hash, new Date().toISOString());
  const app = createApp({ db, config: {}, ai });
  const server = app.listen(0);
  servers.push(server);
  const base = `http://localhost:${server.address().port}`;
  const raw = (path, { method = "GET", body, cookie, type = "application/json" } = {}) =>
    fetch(base + path, { method, headers: { ...(type ? { "content-type": type } : {}), ...(cookie ? { cookie } : {}) }, body: body && JSON.stringify(body) });
  const parse = async r => ({ status: r.status, body: r.status === 204 ? null : await r.json(), setCookie: r.headers.get("set-cookie") });
  // Signs in and returns a call() bound to that session. role: admin | author | learner | null (signed out)
  const as = async role => {
    let cookie;
    if (role) {
      const login = await parse(await raw("/api/auth/login", { method: "POST", body: { email: `${role}@example.com`, password: PW } }));
      cookie = login.setCookie.split(";")[0];
    }
    return (path, opts = {}) => raw(path, { ...opts, cookie }).then(parse);
  };
  return { db, raw, parse, as, close: () => { server.closeAllConnections(); server.close(); } };
}

test("authoring needs an author or admin; learners and signed-out users are refused", async () => {
  const s = await start();
  assert.equal((await (await s.as(null))("/api/admin/courses")).status, 401);
  assert.equal((await (await s.as("learner"))("/api/admin/courses")).status, 403);
  assert.equal((await (await s.as("author"))("/api/admin/courses")).status, 200);
  s.close();
});

test("draft, approve, publish, learner quiz never leaks answers", async () => {
  const s = await start();
  const author = await s.as("author"), learner = await s.as("learner"), out = await s.as(null);
  const made = await author("/api/admin/ai/draft-course", { method: "POST", body: { text: SOURCE } });
  assert.equal(made.status, 201);
  const id = made.body.id;
  assert.equal((await learner(`/api/courses/${id}`)).status, 404); // unpublished
  const full = (await author(`/api/admin/courses/${id}`)).body;
  assert.ok(full.lessons.length >= 1 && full.questions.every(q => q.status === "draft" && q.source === "ai"));
  await author(`/api/admin/questions/${full.questions[0].id}`, { method: "PATCH", body: { status: "approved" } });
  await author(`/api/admin/courses/${id}/publish`, { method: "POST", body: {} });
  assert.equal((await out(`/api/courses/${id}`)).status, 401);
  assert.equal((await learner(`/api/courses/${id}`)).status, 404); // published but not enrolled
  await author(`/api/admin/courses/${id}/enrolments`, { method: "POST", body: { emails: ["learner@example.com"] } });
  const view = (await learner(`/api/courses/${id}`)).body;
  assert.equal(view.questions.length, 1); // only the approved one
  assert.ok(!("answer" in view.questions[0]));
  const marked = (await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: { [view.questions[0].id]: 0 } } })).body;
  assert.deepEqual([marked.score, marked.total], [1, 1]);
  s.close();
});

test("generating a quiz adds draft questions", async () => {
  const s = await start();
  const author = await s.as("author");
  const { body: { id } } = await author("/api/admin/ai/draft-course", { method: "POST", body: { text: SOURCE } });
  const r = await author(`/api/admin/courses/${id}/quiz/generate`, { method: "POST", body: { count: 2 } });
  assert.equal(r.status, 201);
  assert.equal(r.body.added, 2);
  s.close();
});

test("too-short source is refused and AI off returns 503", async () => {
  const s = await start();
  assert.equal((await (await s.as("author"))("/api/admin/ai/draft-course", { method: "POST", body: { text: "hi" } })).status, 400);
  const off = await start({ name: "off" });
  assert.equal((await (await off.as("author"))("/api/admin/ai/draft-course", { method: "POST", body: { text: SOURCE } })).status, 503);
});

test("login: wrong password and unknown email get the same answer; cookie is httpOnly", async () => {
  const s = await start();
  const wrong = await s.parse(await s.raw("/api/auth/login", { method: "POST", body: { email: "learner@example.com", password: "nope-nope-nope" } }));
  const unknown = await s.parse(await s.raw("/api/auth/login", { method: "POST", body: { email: "ghost@example.com", password: "nope-nope-nope" } }));
  assert.deepEqual([wrong.status, wrong.body], [unknown.status, unknown.body]);
  const ok = await s.parse(await s.raw("/api/auth/login", { method: "POST", body: { email: "LEARNER@example.com", password: PW } }));
  assert.equal(ok.status, 200);
  assert.match(ok.setCookie, /HttpOnly/);
  assert.match(ok.setCookie, /SameSite=Lax/);
  const row = s.db.prepare("SELECT id_hash FROM sessions").get();
  assert.ok(!ok.setCookie.includes(row.id_hash)); // the database holds a hash, not the cookie value
});

test("logout ends the session; writes without a JSON content type are refused", async () => {
  const s = await start();
  const login = await s.parse(await s.raw("/api/auth/login", { method: "POST", body: { email: "learner@example.com", password: PW } }));
  const cookie = login.setCookie.split(";")[0];
  assert.equal((await s.parse(await s.raw("/api/auth/me", { cookie }))).status, 200);
  assert.equal((await s.raw("/api/auth/logout", { method: "POST", cookie, type: "text/plain" })).status, 415);
  assert.equal((await s.raw("/api/auth/logout", { method: "POST", cookie })).status, 204);
  assert.equal((await s.parse(await s.raw("/api/auth/me", { cookie }))).status, 401);
});

test("admin creates users; only admins can; deactivating ends their sessions; last admin is protected", async () => {
  const s = await start();
  const admin = await s.as("admin"), author = await s.as("author"), learner = await s.as("learner");
  assert.equal((await author("/api/admin/users")).status, 403);
  const made = await admin("/api/admin/users", { method: "POST", body: { email: "new@example.com", role: "author" } });
  assert.equal(made.status, 201);
  assert.ok(made.body.temporaryPassword.length >= 10);
  assert.equal((await admin("/api/admin/users", { method: "POST", body: { email: "NEW@example.com" } })).status, 409);
  assert.equal((await admin("/api/admin/users", { method: "POST", body: { email: "x@example.com", role: "root" } })).status, 400);
  const learnerId = s.db.prepare("SELECT id FROM users WHERE email = 'learner@example.com'").pluck().get();
  await admin(`/api/admin/users/${learnerId}`, { method: "PATCH", body: { active: false } });
  assert.equal((await learner("/api/auth/me")).status, 401);
  const adminId = s.db.prepare("SELECT id FROM users WHERE email = 'admin@example.com'").pluck().get();
  assert.equal((await admin(`/api/admin/users/${adminId}`, { method: "PATCH", body: { role: "learner" } })).status, 409);
  s.close();
});

test("changing password needs the current one and ends other sessions", async () => {
  const s = await start();
  const a = await s.as("learner"), b = await s.as("learner");
  assert.equal((await a("/api/auth/password", { method: "POST", body: { current: "wrong-wrong-wrong", next: "a-new-long-password" } })).status, 401);
  assert.equal((await a("/api/auth/password", { method: "POST", body: { current: PW, next: "short" } })).status, 400);
  assert.equal((await a("/api/auth/password", { method: "POST", body: { current: PW, next: "a-new-long-password" } })).status, 204);
  assert.equal((await b("/api/auth/me")).status, 401); // the other session was ended
  const again = await s.parse(await s.raw("/api/auth/login", { method: "POST", body: { email: "learner@example.com", password: "a-new-long-password" } }));
  assert.equal(again.status, 200);
});

async function publishedCourse(s) {
  const author = await s.as("author");
  const { body: { id } } = await author("/api/admin/ai/draft-course", { method: "POST", body: { text: SOURCE } });
  await author(`/api/admin/courses/${id}/publish`, { method: "POST", body: {} });
  return { author, id };
}

test("enrolment: manual courses need staff to enrol; results report unknown emails; unenrol removes access", async () => {
  const s = await start();
  const { author, id } = await publishedCourse(s);
  const learner = await s.as("learner");
  assert.deepEqual((await learner("/api/courses")).body, []);
  assert.equal((await learner(`/api/courses/${id}/enrol`, { method: "POST", body: {} })).status, 404); // manual, not open
  assert.equal((await learner(`/api/admin/courses/${id}/enrolments`, { method: "POST", body: { emails: ["learner@example.com"] } })).status, 403);
  const r = await author(`/api/admin/courses/${id}/enrolments`, { method: "POST", body: { emails: ["Learner@example.com", "learner@example.com", "ghost@example.com"] } });
  assert.deepEqual(r.body, { enrolled: ["learner@example.com"], alreadyEnrolled: [], notFound: ["ghost@example.com"] });
  assert.equal((await author(`/api/admin/courses/${id}/enrolments`, { method: "POST", body: { emails: ["learner@example.com"] } })).body.alreadyEnrolled.length, 1);
  assert.equal((await learner("/api/courses")).body.length, 1);
  assert.equal((await learner(`/api/courses/${id}`)).status, 200);
  const list = (await author(`/api/admin/courses/${id}/enrolments`)).body;
  assert.deepEqual(list.map(e => [e.email, e.self_enrolled]), [["learner@example.com", false]]);
  const lid = list[0].id;
  assert.equal((await author(`/api/admin/courses/${id}/enrolments/${lid}`, { method: "DELETE" })).status, 204);
  assert.equal((await learner(`/api/courses/${id}`)).status, 404);
  assert.equal((await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: {} } })).status, 404);
  s.close();
});

test("open enrolment: learners can self-enrol and it is recorded as such; staff can preview without enrolling", async () => {
  const s = await start();
  const { author, id } = await publishedCourse(s);
  const learner = await s.as("learner");
  assert.equal((await author(`/api/admin/courses/${id}`, { method: "PATCH", body: { enrolment: "sometimes" } })).status, 400);
  await author(`/api/admin/courses/${id}`, { method: "PATCH", body: { enrolment: "open", title: "Renamed" } });
  assert.deepEqual((await learner("/api/courses/available")).body.map(c => c.title), ["Renamed"]);
  assert.equal((await learner(`/api/courses/${id}/enrol`, { method: "POST", body: {} })).status, 201);
  assert.deepEqual((await learner("/api/courses/available")).body, []);
  assert.equal((await learner("/api/courses")).body.length, 1);
  assert.equal((await author(`/api/admin/courses/${id}/enrolments`)).body[0].self_enrolled, true);
  assert.equal((await author(`/api/courses/${id}`)).status, 200); // staff preview
  assert.equal((await author(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: {} } })).status, 403); // but not take the quiz
  s.close();
});

// A published course with 3 approved questions (correct option is always index 0 with the stub AI), learner enrolled.
async function quizCourse(s, settings = {}) {
  const { author, id } = await publishedCourse(s);
  await author(`/api/admin/courses/${id}/quiz/generate`, { method: "POST", body: { count: 2 } });
  const full = (await author(`/api/admin/courses/${id}`)).body;
  for (const q of full.questions) await author(`/api/admin/questions/${q.id}`, { method: "PATCH", body: { status: "approved" } });
  await author(`/api/admin/courses/${id}`, { method: "PATCH", body: settings });
  await author(`/api/admin/courses/${id}/enrolments`, { method: "POST", body: { emails: ["learner@example.com"] } });
  const answers = pick => Object.fromEntries(full.questions.map(q => [q.id, pick]));
  return { author, id, qids: full.questions.map(q => q.id), answers };
}

test("attempts: scored on the server, pass mark applied, answers hidden until passed (default), history kept", async () => {
  const s = await start();
  const { id, answers } = await quizCourse(s);
  const learner = await s.as("learner");
  const fail = await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: answers(1) } });
  assert.equal(fail.status, 201);
  assert.deepEqual([fail.body.score, fail.body.total, fail.body.percent, fail.body.passed], [0, 3, 0, false]);
  assert.ok(fail.body.results.every(r => !("answer" in r) && !("explanation" in r)));       // not revealed after a fail
  const pass = await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: answers(0) } });
  assert.deepEqual([pass.body.percent, pass.body.passed, pass.body.attemptsUsed], [100, true, 2]);
  assert.ok(pass.body.results.every(r => r.answer === 0));                                   // revealed once passed
  const list = (await learner(`/api/courses/${id}/attempts`)).body;
  assert.deepEqual([list.attemptsUsed, list.passed, list.attempts.map(a => a.percent)], [2, true, [100, 0]]);
  assert.ok("answer" in (await learner(`/api/attempts/${fail.body.id}`)).body.results[0]);   // the old attempt is now reviewable
  assert.equal((await (await s.as("author"))(`/api/attempts/${fail.body.id}`)).status, 404);  // not someone else's
  assert.deepEqual((await learner("/api/grades")).body.map(g => [g.attempts, g.bestPercent, g.passed]), [[2, 100, true]]);
  s.close();
});

test("attempts: unanswered and out-of-range answers are wrong; attempt limit enforced; no quiz means 409", async () => {
  const s = await start();
  const { id, qids } = await quizCourse(s, { maxAttempts: 2, passMark: 50 });
  const learner = await s.as("learner");
  const partial = await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: { [qids[0]]: 0, [qids[1]]: 99, [qids[2]]: "0" } } });
  assert.deepEqual([partial.body.score, partial.body.percent, partial.body.passed], [1, 33, false]);
  await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: {} } });
  const third = await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: {} } });
  assert.equal(third.status, 409);
  assert.equal((await learner(`/api/courses/${id}/attempts`)).body.attemptsUsed, 2);

  const { author, id: empty } = await publishedCourse(s);
  await author(`/api/admin/courses/${empty}/enrolments`, { method: "POST", body: { emails: ["learner@example.com"] } });
  assert.equal((await learner(`/api/courses/${empty}/quiz`, { method: "POST", body: { answers: {} } })).status, 409);
  s.close();
});

test("quiz settings are validated; showAnswers 'always' reveals straight away", async () => {
  const s = await start();
  const { author, id, answers } = await quizCourse(s, { showAnswers: "always" });
  for (const body of [{ passMark: 101 }, { passMark: "70" }, { maxAttempts: 0 }, { maxAttempts: 51 }, { showAnswers: "sometimes" }])
    assert.equal((await author(`/api/admin/courses/${id}`, { method: "PATCH", body })).status, 400, JSON.stringify(body));
  assert.equal((await author(`/api/admin/courses/${id}`, { method: "PATCH", body: { maxAttempts: null } })).status, 200);
  const r = await (await s.as("learner"))(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: answers(1) } });
  assert.ok(r.body.results.every(x => x.answer === 0));
  s.close();
});

test("gradebook: includes enrolled people with no attempts, summarises, ranks hard questions, staff only", async () => {
  const s = await start();
  const { author, id, qids, answers } = await quizCourse(s);
  await author(`/api/admin/courses/${id}/enrolments`, { method: "POST", body: { emails: ["admin@example.com"] } });
  const learner = await s.as("learner");
  await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: { ...answers(0), [qids[0]]: 1 } } });   // 2 of 3
  assert.equal((await learner(`/api/admin/courses/${id}/gradebook`)).status, 403);
  const g = (await author(`/api/admin/courses/${id}/gradebook`)).body;
  assert.deepEqual(g.summary, { enrolled: 2, attempted: 1, passed: 0, averageBestPercent: 67 });
  assert.deepEqual(g.learners.map(l => [l.email, l.attempts, l.bestPercent, l.passed]), [["admin@example.com", 0, null, false], ["learner@example.com", 1, 67, false]]);
  assert.equal(g.questions[0].id, qids[0]);              // the missed question ranks first
  assert.equal(g.questions[0].percentCorrect, 0);
  const lid = g.learners[1].userId;
  const detail = (await author(`/api/admin/courses/${id}/users/${lid}/attempts`)).body;
  assert.equal(detail.length, 1);
  assert.equal(detail[0].results[0].chosen, 1);
  s.close();
});

test("gradebook CSV defangs spreadsheet formulas and is staff only", async () => {
  const s = await start();
  const { author, id } = await quizCourse(s);
  const admin = await s.as("admin");
  const lid = s.db.prepare("SELECT id FROM users WHERE email = 'learner@example.com'").pluck().get();
  await admin(`/api/admin/users/${lid}`, { method: "PATCH", body: { name: '=HYPERLINK("http://x")' } });
  const res = await s.raw(`/api/admin/courses/${id}/gradebook.csv`, { cookie: (await (async () => { const l = await s.parse(await s.raw("/api/auth/login", { method: "POST", body: { email: "author@example.com", password: PW } })); return l.setCookie.split(";")[0]; })()) });
  const csv = await res.text();
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"")"`), csv);
  assert.equal((await (await s.as("learner"))(`/api/admin/courses/${id}/gradebook.csv`)).status, 403);
});

test("tidyQuestions drops bad questions; cleanBody strips scripts", () => {
  const flags = [];
  const out = tidyQuestions([
    { prompt: "Ok?", options: ["a", "b"], answer: 1, explanation: "" },
    { prompt: "Bad index", options: ["a", "b"], answer: 5, explanation: "" },
    { prompt: "Dupes", options: ["a", "a"], answer: 0, explanation: "" },
  ], flags);
  assert.equal(out.length, 1);
  assert.equal(flags.length, 2);
  assert.ok(!cleanBody('<p>hi</p><script>alert(1)</script><a href="javascript:x">l</a>').includes("script"));
});
