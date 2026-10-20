import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../db.js";
import { createApp } from "../app.js";
import { hashPassword } from "../auth.js";
import { contrast, cleanTheme } from "../theme.js";
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
  assert.deepEqual(g.summary, { enrolled: 2, attempted: 1, passed: 0, completed: 0, lessons: 1, averageBestPercent: 67 });
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

// Adds extra lessons straight into the database (there is no lesson-editing API yet).
const addLessons = (s, courseId, n) => { for (let i = 0; i < n; i++) s.db.prepare("INSERT INTO lessons (course_id, position, title, body) VALUES (?, ?, ?, '<p>x</p>')").run(courseId, 10 + i, `Extra ${i}`); };
const lessonIds = async (learner, id) => (await learner(`/api/courses/${id}/progress`)).body.lessons.map(l => l.id);

test("completion: default rule needs every lesson done and the quiz passed; marking is idempotent and undoable", async () => {
  const s = await start();
  const { id, answers } = await quizCourse(s);
  addLessons(s, id, 1);                                    // 2 lessons in total
  const learner = await s.as("learner");
  const [l1, l2] = await lessonIds(learner, id);
  let p = (await learner(`/api/courses/${id}/progress`)).body;
  assert.deepEqual([p.rule, p.percent, p.completed, p.quiz], ["both", 0, false, { required: true, passed: false }]);

  assert.equal((await learner(`/api/courses/${id}/lessons/${l1}/complete`, { method: "POST", body: {} })).body.percent, 33);   // 1 of 3 requirements
  assert.equal((await learner(`/api/courses/${id}/lessons/${l1}/complete`, { method: "POST", body: {} })).body.percent, 33);   // again: no change
  await learner(`/api/courses/${id}/lessons/${l2}/complete`, { method: "POST", body: {} });
  p = (await learner(`/api/courses/${id}/progress`)).body;
  assert.deepEqual([p.percent, p.completed], [67, false]);                                // lessons done, quiz outstanding
  assert.equal((await learner(`/api/courses/${id}/lessons/${l2}/complete`, { method: "DELETE" })).body.percent, 33);              // undo works

  await learner(`/api/courses/${id}/lessons/${l2}/complete`, { method: "POST", body: {} });
  await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: answers(0) } });   // passing completes the course
  p = (await learner(`/api/courses/${id}/progress`)).body;
  assert.deepEqual([p.percent, p.completed], [100, true]);
  assert.ok(p.completedAt);
  assert.deepEqual((await learner("/api/courses")).body.map(c => [c.percent, c.completed]), [[100, true]]);
  s.close();
});

test("completion is sticky: unticking a lesson or adding a lesson later doesn't take it back", async () => {
  const s = await start();
  const { id, answers } = await quizCourse(s, { completion: "both" });
  const learner = await s.as("learner");
  const [l1] = await lessonIds(learner, id);
  await learner(`/api/courses/${id}/lessons/${l1}/complete`, { method: "POST", body: {} });
  await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: answers(0) } });
  const first = (await learner(`/api/courses/${id}/progress`)).body.completedAt;
  assert.ok(first);
  await learner(`/api/courses/${id}/lessons/${l1}/complete`, { method: "DELETE" });
  addLessons(s, id, 2);
  const p = (await learner(`/api/courses/${id}/progress`)).body;
  assert.deepEqual([p.completed, p.completedAt, p.percent], [true, first, 100]);
  s.close();
});

test("completion rules: lessons-only ignores the quiz; quiz-only ignores lessons; changing the rule completes people who now qualify", async () => {
  const s = await start();
  const { author, id, answers } = await quizCourse(s, { completion: "lessons" });
  const learner = await s.as("learner");
  const [l1] = await lessonIds(learner, id);
  await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: answers(0) } });          // quiz passed, no lessons yet
  assert.equal((await learner(`/api/courses/${id}/progress`)).body.completed, false);                   // lessons-only rule: not enough
  await author(`/api/admin/courses/${id}`, { method: "PATCH", body: { completion: "quiz" } });             // now the quiz alone qualifies
  assert.equal((await learner(`/api/courses/${id}/progress`)).body.completed, true);
  assert.equal((await author(`/api/admin/courses/${id}`, { method: "PATCH", body: { completion: "never" } })).status, 400);

  const second = await quizCourse(s, { completion: "lessons" });                                          // lessons-only completes with no quiz taken
  const [m1] = await lessonIds(learner, second.id);
  assert.equal((await learner(`/api/courses/${second.id}/lessons/${m1}/complete`, { method: "POST", body: {} })).body.completed, true);
  s.close();
});

test("completion access: lessons must belong to the course; staff preview and non-enrolled people can't track progress", async () => {
  const s = await start();
  const a = await quizCourse(s), b = await quizCourse(s);
  const learner = await s.as("learner"), author = await s.as("author");
  const [bLesson] = await lessonIds(learner, b.id);
  assert.equal((await learner(`/api/courses/${a.id}/lessons/${bLesson}/complete`, { method: "POST", body: {} })).status, 404);   // another course's lesson
  assert.equal((await learner(`/api/courses/${a.id}/lessons/9999/complete`, { method: "POST", body: {} })).status, 404);
  const [aLesson] = await lessonIds(learner, a.id);
  assert.equal((await author(`/api/courses/${a.id}/lessons/${aLesson}/complete`, { method: "POST", body: {} })).status, 403);     // staff preview
  const ghost = await publishedCourse(s);                                                                    // learner isn't enrolled here
  assert.equal((await learner(`/api/courses/${ghost.id}/progress`)).status, 404);
  s.close();
});

test("gradebook shows completion for staff, and the CSV has a Completed column", async () => {
  const s = await start();
  const { author, id, answers } = await quizCourse(s);
  const learner = await s.as("learner");
  const [l1] = await lessonIds(learner, id);
  await learner(`/api/courses/${id}/lessons/${l1}/complete`, { method: "POST", body: {} });
  await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: answers(0) } });
  const g = (await author(`/api/admin/courses/${id}/gradebook`)).body;
  assert.equal(g.summary.completed, 1);
  assert.deepEqual([g.learners[0].lessonsCompleted, !!g.learners[0].completedAt], [1, true]);
  const login = await s.parse(await s.raw("/api/auth/login", { method: "POST", body: { email: "author@example.com", password: PW } }));
  const csv = await (await s.raw(`/api/admin/courses/${id}/gradebook.csv`, { cookie: login.setCookie.split(";")[0] })).text();
  assert.match(csv.split("\r\n")[0], /Completed/);
  s.close();
});

test("authoring: build a course from scratch with lessons and questions, then publish it", async () => {
  const s = await start();
  const author = await s.as("author"), learner = await s.as("learner");
  assert.equal((await learner("/api/admin/courses", { method: "POST", body: { title: "No" } })).status, 403);
  assert.equal((await author("/api/admin/courses", { method: "POST", body: { title: "  " } })).status, 400);
  const { body: { id } } = await author("/api/admin/courses", { method: "POST", body: { title: "<b>Handling complaints</b>", description: "How we respond" } });
  assert.equal((await author(`/api/admin/courses/${id}/publish`, { method: "POST", body: {} })).status, 400);   // no lessons yet

  const l1 = await author(`/api/admin/courses/${id}/lessons`, { method: "POST", body: { title: "Listen first", body: '<p>Hi</p><script>alert(1)</script>' } });
  assert.equal(l1.status, 201);
  assert.ok(!l1.body.body.includes("script"));                                                                         // sanitised
  assert.equal((await author(`/api/admin/courses/${id}/lessons`, { method: "POST", body: { title: "", body: "<p>x</p>" } })).status, 400);
  assert.equal((await author(`/api/admin/courses/${id}/lessons`, { method: "POST", body: { title: "Empty", body: "<script>x</script>" } })).status, 400);
  const l2 = await author(`/api/admin/courses/${id}/lessons`, { method: "POST", body: { title: "Then respond", body: "<p>Reply</p>" } });
  assert.deepEqual([l1.body.position, l2.body.position], [0, 1]);

  const q = await author(`/api/admin/courses/${id}/questions`, { method: "POST", body: { prompt: "First step?", options: ["Listen", "Argue"], answer: 0, explanation: "Hear them out." } });
  assert.equal(q.status, 201);
  assert.deepEqual([q.body.source, q.body.status], ["manual", "approved"]);
  assert.equal((await author(`/api/admin/courses/${id}/questions`, { method: "POST", body: { prompt: "Bad", options: ["a", "b"], answer: 7 } })).status, 400);
  assert.equal((await author(`/api/admin/courses/${id}/questions`, { method: "POST", body: { prompt: "Bad", options: ["a", "a"], answer: 0 } })).status, 400);

  assert.equal((await author(`/api/admin/courses/${id}/publish`, { method: "POST", body: {} })).status, 200);
  const full = (await author(`/api/admin/courses/${id}`)).body;
  assert.deepEqual([full.title, full.lessons.length, full.questions.length], ["Handling complaints", 2, 1]);
  s.close();
});

test("authoring: edit lessons, reorder lessons and questions (exact set only), delete closes position gaps", async () => {
  const s = await start();
  const { author, id } = await quizCourse(s);
  addLessons(s, id, 2);
  let lessons = (await author(`/api/admin/courses/${id}`)).body.lessons;
  const [a, b, c] = lessons.map(l => l.id);
  const edited = await author(`/api/admin/lessons/${a}`, { method: "PATCH", body: { title: "Renamed" } });
  assert.deepEqual([edited.status, edited.body.title, edited.body.body.length > 0], [200, "Renamed", true]);   // body kept when not sent
  assert.equal((await author(`/api/admin/lessons/${a}`, { method: "PATCH", body: { title: "" } })).status, 400);

  for (const order of [[a, b], [a, b, b], [a, b, 9999], "nope"])
    assert.equal((await author(`/api/admin/courses/${id}/lessons/order`, { method: "PUT", body: { order } })).status, 400, JSON.stringify(order));
  assert.equal((await author(`/api/admin/courses/${id}/lessons/order`, { method: "PUT", body: { order: [c, a, b] } })).status, 200);
  assert.deepEqual((await author(`/api/admin/courses/${id}`)).body.lessons.map(l => l.id), [c, a, b]);

  assert.equal((await author(`/api/admin/lessons/${a}`, { method: "DELETE" })).status, 204);
  assert.deepEqual((await author(`/api/admin/courses/${id}`)).body.lessons.map(l => [l.id, l.position]), [[c, 0], [b, 1]]);

  const qs = (await author(`/api/admin/courses/${id}`)).body.questions.map(q => q.id);
  assert.equal((await author(`/api/admin/courses/${id}/questions/order`, { method: "PUT", body: { order: [...qs].reverse() } })).status, 200);
  assert.deepEqual((await author(`/api/admin/courses/${id}`)).body.questions.map(q => q.id), [...qs].reverse());
  s.close();
});

test("authoring: a published course keeps at least one lesson; deleting a lesson re-checks completion and drops ticks, not completions", async () => {
  const s = await start();
  const { author, id, answers } = await quizCourse(s);
  addLessons(s, id, 1);                                                              // two lessons
  const learner = await s.as("learner");
  const [l1, l2] = await lessonIds(learner, id);
  await learner(`/api/courses/${id}/lessons/${l1}/complete`, { method: "POST", body: {} });
  await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: answers(0) } });
  assert.equal((await learner(`/api/courses/${id}/progress`)).body.completed, false);   // lesson 2 outstanding

  await author(`/api/admin/lessons/${l2}`, { method: "DELETE" });                    // the only thing missing is gone
  assert.equal((await learner(`/api/courses/${id}/progress`)).body.completed, true);
  assert.equal((await author(`/api/admin/lessons/${l1}`, { method: "DELETE" })).status, 409);   // last lesson of a published course
  s.close();
});

test("authoring: changing questions re-checks completion; editing a question never rewrites an old attempt", async () => {
  const s = await start();
  const { author, id, qids, answers } = await quizCourse(s, { completion: "both" });
  const learner = await s.as("learner");
  const [l1] = await lessonIds(learner, id);
  await learner(`/api/courses/${id}/lessons/${l1}/complete`, { method: "POST", body: {} });
  const attempt = await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: answers(1) } });   // fails
  assert.equal((await learner(`/api/courses/${id}/progress`)).body.completed, false);
  await author(`/api/admin/questions/${qids[0]}`, { method: "PATCH", body: { prompt: "Completely different question?" } });
  const old = (await learner(`/api/attempts/${attempt.body.id}`)).body;
  assert.match(old.results[0].prompt, /Placeholder/);                                // snapshot, not the edited text

  for (const qid of qids) await author(`/api/admin/questions/${qid}`, { method: "DELETE" });   // no quiz left, lessons done
  assert.equal((await learner(`/api/courses/${id}/progress`)).body.completed, true);
  s.close();
});

test("authoring: only drafts can be deleted; unpublish hides the course but keeps enrolments and attempts", async () => {
  const s = await start();
  const { author, id, answers } = await quizCourse(s);
  const learner = await s.as("learner");
  await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: answers(0) } });
  assert.equal((await author(`/api/admin/courses/${id}`, { method: "DELETE" })).status, 409);       // published
  await author(`/api/admin/courses/${id}/unpublish`, { method: "POST", body: {} });
  assert.equal((await learner(`/api/courses/${id}`)).status, 404);
  assert.equal((await author(`/api/admin/courses/${id}/enrolments`)).body.length, 1);               // kept
  await author(`/api/admin/courses/${id}/publish`, { method: "POST", body: {} });
  assert.equal((await learner(`/api/courses/${id}/attempts`)).body.attemptsUsed, 1);                // kept
  await author(`/api/admin/courses/${id}/unpublish`, { method: "POST", body: {} });
  assert.equal((await author(`/api/admin/courses/${id}`, { method: "DELETE" })).status, 204);
  assert.equal((await author(`/api/admin/courses/${id}`)).status, 404);
  s.close();
});

// Completes the course for a learner: tick every lesson, pass the quiz.
async function complete(learner, id, answers) {
  for (const lid of await lessonIds(learner, id)) await learner(`/api/courses/${id}/lessons/${lid}/complete`, { method: "POST", body: {} });
  await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: answers(0) } });
}
const addUser = async (s, email, name = "") =>
  s.db.prepare("INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?, ?, 'learner', ?, ?)").run(email, name, await hashPassword(PW), new Date().toISOString());
const loginAs = async (s, email) => {
  const l = await s.parse(await s.raw("/api/auth/login", { method: "POST", body: { email, password: PW } }));
  const cookie = l.setCookie.split(";")[0];
  return (path, opts = {}) => s.raw(path, { ...opts, cookie }).then(s.parse);
};

test("certificates: issued on completion with a unique code per learner; one per learner per course", async () => {
  const s = await start();
  const { author, id, answers } = await quizCourse(s);
  await addUser(s, "second@example.com", "Second Person");
  await author(`/api/admin/courses/${id}/enrolments`, { method: "POST", body: { emails: ["second@example.com"] } });
  const one = await s.as("learner"), two = await loginAs(s, "second@example.com");

  assert.equal((await one(`/api/courses/${id}/certificate`)).status, 404);               // not completed yet
  assert.deepEqual((await one("/api/certificates")).body, []);
  await complete(one, id, answers);
  await complete(two, id, answers);
  const a = (await one(`/api/courses/${id}/certificate`)).body, b = (await two(`/api/courses/${id}/certificate`)).body;
  assert.match(a.code, /^LL-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
  assert.notEqual(a.code, b.code);
  assert.equal(b.recipientName, "Second Person");
  assert.equal(a.recipientName, "learner@example.com");                                  // no name set: falls back to email
  await complete(one, id, answers);                                                        // completing again changes nothing
  assert.equal((await one("/api/certificates")).body.length, 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) FROM certificates").pluck().get(), 2);
  s.close();
});

test("certificates: public verification needs no sign-in, accepts lower case and stray spaces, and the page escapes names", async () => {
  const s = await start();
  const { id, answers } = await quizCourse(s);
  const learner = await s.as("learner");
  await learner("/api/auth/me", { method: "PATCH", body: { name: "Sam <img src=x onerror=alert(1)>" } });
  await complete(learner, id, answers);
  const cert = (await learner(`/api/courses/${id}/certificate`)).body;
  assert.equal(cert.recipientName, "Sam img src=x onerror=alert(1)");                    // angle brackets stripped on the way in

  const ok = await s.parse(await s.raw(`/api/verify/${encodeURIComponent(" " + cert.code.toLowerCase() + " ")}`));
  assert.deepEqual([ok.status, ok.body.valid, ok.body.revoked], [200, true, false]);
  assert.equal((await s.parse(await s.raw("/api/verify/LL-AAAAA-AAAAA"))).status, 404);

  const html = await (await s.raw(`/certificate/${cert.code}`)).text();
  assert.match(html, /Certificate of completion/);
  assert.ok(html.includes("onerror=alert(1)") && !html.includes("<img"));
  const missing = await s.raw("/certificate/LL-AAAAA-AAAAA");
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /Certificate not found/);
  s.close();
});

test("certificates: staff can list, correct a name, revoke and restore; learners can't", async () => {
  const s = await start();
  const { author, id, answers } = await quizCourse(s);
  const learner = await s.as("learner");
  await complete(learner, id, answers);
  const list = (await author(`/api/admin/courses/${id}/certificates`)).body;
  assert.equal(list.length, 1);
  const cid = list[0].id;
  assert.equal((await learner(`/api/admin/certificates/${cid}`, { method: "PATCH", body: { revoked: true } })).status, 403);
  assert.equal((await author(`/api/admin/certificates/${cid}`, { method: "PATCH", body: { recipientName: "  " } })).status, 400);
  await author(`/api/admin/certificates/${cid}`, { method: "PATCH", body: { recipientName: "Alex Example" } });
  await author(`/api/admin/certificates/${cid}`, { method: "PATCH", body: { revoked: true, reason: "Issued in error" } });
  const v = (await s.parse(await s.raw(`/api/verify/${list[0].code}`))).body;
  assert.deepEqual([v.valid, v.revoked, v.recipientName], [false, true, "Alex Example"]);
  assert.match(await (await s.raw(`/certificate/${list[0].code}`)).text(), /revoked/);
  assert.equal((await author(`/api/admin/courses/${id}/certificates`)).body[0].revokedReason, "Issued in error");
  await author(`/api/admin/certificates/${cid}`, { method: "PATCH", body: { revoked: false } });
  assert.equal((await s.parse(await s.raw(`/api/verify/${list[0].code}`))).body.valid, true);
  s.close();
});

test("certificates: switched off issues none; switching on later issues for people who already completed", async () => {
  const s = await start();
  const { author, id, answers } = await quizCourse(s, { certificate: false });
  const learner = await s.as("learner");
  await complete(learner, id, answers);
  assert.equal((await learner(`/api/courses/${id}/certificate`)).status, 404);
  assert.equal(s.db.prepare("SELECT COUNT(*) FROM certificates").pluck().get(), 0);
  assert.equal((await author(`/api/admin/courses/${id}`, { method: "PATCH", body: { certificate: "yes" } })).status, 400);
  await author(`/api/admin/courses/${id}`, { method: "PATCH", body: { certificate: true } });
  assert.equal((await learner(`/api/courses/${id}/certificate`)).status, 200);
  s.close();
});

test("certificates survive their course being deleted and stay verifiable", async () => {
  const s = await start();
  const { author, id, answers } = await quizCourse(s);
  const learner = await s.as("learner");
  await complete(learner, id, answers);
  const { code } = (await learner(`/api/courses/${id}/certificate`)).body;
  await author(`/api/admin/courses/${id}/unpublish`, { method: "POST", body: {} });
  assert.equal((await author(`/api/admin/courses/${id}`, { method: "DELETE" })).status, 204);
  const v = (await s.parse(await s.raw(`/api/verify/${code}`))).body;
  assert.deepEqual([v.valid, v.courseTitle.length > 0], [true, true]);
  assert.equal((await learner("/api/certificates")).body.length, 1);
  s.close();
});

test("a temporary password must be replaced before anything else works", async () => {
  const s = await start();
  const admin = await s.as("admin");
  const made = (await admin("/api/admin/users", { method: "POST", body: { email: "fresh@example.com" } })).body;
  const login = await s.parse(await s.raw("/api/auth/login", { method: "POST", body: { email: "fresh@example.com", password: made.temporaryPassword } }));
  assert.equal(login.body.mustChangePassword, true);
  const fresh = (path, opts = {}) => s.raw(path, { ...opts, cookie: login.setCookie.split(";")[0] }).then(s.parse);
  const blocked = await fresh("/api/courses");
  assert.deepEqual([blocked.status, blocked.body.mustChangePassword], [403, true]);
  assert.equal((await fresh("/api/auth/me")).status, 200);                                                   // still allowed
  const changed = await fresh("/api/auth/password", { method: "POST", body: { current: made.temporaryPassword, next: "my-own-long-password" } });
  assert.equal(changed.status, 204);
  assert.equal((await fresh("/api/courses")).status, 401);                                                   // the old session was ended
  const next = await s.parse(await s.raw("/api/courses", { cookie: changed.setCookie.split(";")[0] }));
  assert.equal(next.status, 200);                                                                            // the new one works
  s.close();
});

const DARK = { background: "#14171d", surface: "#1c212b", text: "#e8ebf1", link: "#6f9bff" };

test("theme: public to read, admin only to change; colours come in groups and must stay readable", async () => {
  const s = await start();
  const admin = await s.as("admin"), author = await s.as("author"), out = await s.as(null);
  assert.deepEqual((await out("/api/theme")).body, { siteName: "", font: "system", fontSize: "normal", colours: {} });
  assert.equal((await author("/api/admin/theme", { method: "PUT", body: { font: "serif" } })).status, 403);
  assert.equal((await out("/api/admin/theme", { method: "PUT", body: { font: "serif" } })).status, 401);

  const bad = async body => (await admin("/api/admin/theme", { method: "PUT", body })).status;
  assert.equal(await bad({ font: "comic-sans" }), 400);
  assert.equal(await bad({ fontSize: "huge" }), 400);
  assert.equal(await bad({ colours: { background: "red" } }), 400);                               // not a hex colour
  assert.equal(await bad({ colours: { background: "#ffffff", surface: "#ffffff" } }), 400);          // half a group
  assert.equal(await bad({ colours: { sparkle: "#ffffff" } }), 400);                               // unknown key
  assert.equal(await bad({ colours: { ...DARK, text: "#1c2030" } }), 400);                         // dark text on dark background
  assert.equal(await bad({ colours: { button: "#ffff00", buttonText: "#ffffff" } }), 400);          // white on yellow

  const ok = await admin("/api/admin/theme", { method: "PUT", body: { siteName: "Acme <b>Academy</b>", font: "serif", fontSize: "large", colours: { ...DARK, button: "#6f9bff", buttonText: "#0b1020" } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.siteName, "Acme bAcademy/b");                                               // angle brackets stripped
  assert.equal((await out("/api/theme")).body.font, "serif");
  s.close();
});

test("theme.css is built only from checked values, applies the choices, and resets", async () => {
  const s = await start();
  const admin = await s.as("admin");
  const css = async () => (await s.raw("/theme.css")).text();
  assert.doesNotMatch(await css(), /--bg:/);                                                       // default: nothing overridden
  await admin("/api/admin/theme", { method: "PUT", body: { font: "mono", fontSize: "small", colours: { ...DARK, button: "#6f9bff", buttonText: "#0b1020", header: "#000000", headerText: "#ffffff" } } });
  const res = await s.raw("/theme.css");
  assert.match(res.headers.get("content-type"), /text\/css/);
  const text = await res.text();
  for (const piece of ["--bg:#14171d", "--accent:#6f9bff", "--accent-text:#0b1020", "--header:#000000", "--header-text:#ffffff", "ui-monospace", "font-size:93.75%", "color-scheme:dark"])
    assert.ok(text.includes(piece), piece);
  assert.equal((await admin("/api/admin/theme", { method: "DELETE" })).status, 200);
  assert.doesNotMatch(await css(), /--bg:/);
  assert.equal((await s.parse(await s.raw("/api/theme"))).body.font, "system");
  s.close();
});

test("theme: the built-in presets are all readable, and a stored bad theme falls back to the default", async () => {
  const presets = [
    { ...DARK, button: "#6f9bff", buttonText: "#0b1020", header: "#1c212b", headerText: "#e8ebf1" },
    { background: "#ffffff", surface: "#ffffff", text: "#000000", link: "#0033cc", button: "#000000", buttonText: "#ffffff", header: "#000000", headerText: "#ffffff" },
    { background: "#faf6ef", surface: "#fffdf8", text: "#2b2118", link: "#9a3d12", button: "#b4501b", buttonText: "#ffffff", header: "#fffdf8", headerText: "#2b2118" },
    { background: "#eef6f9", surface: "#ffffff", text: "#10272f", link: "#0b6a88", button: "#0b6a88", buttonText: "#ffffff", header: "#0b3c4d", headerText: "#ffffff" },
  ];
  for (const colours of presets) assert.ok(cleanTheme({ colours }).value, JSON.stringify(colours));
  assert.ok(contrast("#000000", "#ffffff") > 20);

  const s = await start();
  s.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('theme', ?, ?)").run(JSON.stringify({ font: "nope" }), "x");
  assert.equal((await s.parse(await s.raw("/api/theme"))).body.font, "system");
  s.close();
});

// A 1x1 PNG, and the first bytes of a JPEG, WebP and GIF: the server only looks at the bytes that say what a file is.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const b64 = b => b.toString("base64");

test("cover images: authors can add one; it shows for learners; the address is public but unguessable", async () => {
  const s = await start();
  const { author, id } = await quizCourse(s);
  const learner = await s.as("learner");
  assert.equal((await learner(`/api/admin/courses/${id}/image`, { method: "PUT", body: { data: b64(PNG), alt: "x" } })).status, 403);
  assert.equal((await author(`/api/admin/courses/${id}`)).body.image, null);
  assert.equal((await author(`/api/admin/courses/${id}/image`, { method: "PUT", body: { data: b64(PNG) } })).status, 400);            // alt text needed
  const up = await author(`/api/admin/courses/${id}/image`, { method: "PUT", body: { data: b64(PNG), alt: "<b>A</b> hard hat on a desk" } });
  assert.equal(up.status, 200);
  assert.match(up.body.url, /^\/media\/[A-Za-z0-9_-]{22}$/);
  assert.equal(up.body.alt, "A hard hat on a desk");

  const img = await s.raw(up.body.url);                                                              // no sign-in needed
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.match(img.headers.get("cache-control"), /immutable/);
  assert.equal(img.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);

  assert.equal((await learner("/api/courses")).body[0].image.url, up.body.url);
  assert.equal((await learner(`/api/courses/${id}`)).body.image.alt, "A hard hat on a desk");
  assert.equal((await author(`/api/admin/courses/${id}`)).body.image.url, up.body.url);
  assert.equal((await author("/api/admin/courses")).body.find(c => c.id === id).image.url, up.body.url);
  assert.equal((await s.raw("/media/not-a-real-key")).status, 404);
  s.close();
});

test("cover images: only real images are accepted, size is limited, decorative needs no alt", async () => {
  const s = await start();
  const { author, id } = await quizCourse(s);
  const put = body => author(`/api/admin/courses/${id}/image`, { method: "PUT", body });
  assert.equal((await put({ data: b64(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")), alt: "x" })).status, 400);   // SVG refused
  assert.equal((await put({ data: b64(Buffer.from("just some text pretending to be a picture")), alt: "x" })).status, 400);
  assert.equal((await put({ data: "not base64!!", alt: "x" })).status, 400);
  assert.equal((await put({ alt: "x" })).status, 400);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2 * 1024 * 1024)]);
  assert.equal((await put({ data: b64(big), alt: "x" })).status, 413);
  const dec = await put({ data: b64(jpeg), decorative: true });
  assert.deepEqual([dec.status, dec.body.alt], [200, ""]);
  assert.equal((await s.raw(dec.body.url)).headers.get("content-type"), "image/jpeg");                // type comes from the bytes
  s.close();
});

test("cover images: replacing or removing deletes the old file; deleting a draft course deletes its image", async () => {
  const s = await start();
  const { author, id } = await quizCourse(s);
  const put = () => author(`/api/admin/courses/${id}/image`, { method: "PUT", body: { data: b64(PNG), alt: "Cover" } });
  const first = (await put()).body.url, second = (await put()).body.url;
  assert.notEqual(first, second);
  assert.equal((await s.raw(first)).status, 404);
  assert.equal((await s.raw(second)).status, 200);
  assert.equal(s.db.prepare("SELECT COUNT(*) FROM images").pluck().get(), 1);
  assert.equal((await author(`/api/admin/courses/${id}/image`, { method: "DELETE", body: {} })).status, 204);
  assert.equal((await s.raw(second)).status, 404);
  assert.equal((await author(`/api/admin/courses/${id}`)).body.image, null);

  await put();
  await author(`/api/admin/courses/${id}/unpublish`, { method: "POST", body: {} });
  await author(`/api/admin/courses/${id}`, { method: "DELETE" });
  assert.equal(s.db.prepare("SELECT COUNT(*) FROM images").pluck().get(), 0);
  s.close();
});

const KEY22 = "AAAAAAAAAAAAAAAAAAAAAA";

test("lesson HTML: only this site's own images survive; everything else about an image is stripped", () => {
  const ok = cleanBody(`<p>See:</p><img src="/media/${KEY22}" alt="A hard hat" onerror="alert(1)" width="9999" style="x">`);
  assert.equal(ok, `<p>See:</p><img src="/media/${KEY22}" alt="A hard hat" loading="lazy" />`);
  for (const src of ["https://evil.example/x.png", "http://evil.example/x.png", "//evil.example/x.png", "data:image/png;base64,AAAA", "javascript:alert(1)",
                     "/media/short", `/media/${KEY22}/extra`, `/media/${KEY22}?x=1`, "/other/path.png", ""])
    assert.doesNotMatch(cleanBody(`<p>x</p><img src="${src}" alt="y">`), /<img/, src);
  assert.match(cleanBody(`<img src="/media/${KEY22}">`), /alt=""/);                                       // no description counts as decorative
});

test("lesson images: authors upload, place them in lessons, learners see them; covers and lesson images don't clobber each other", async () => {
  const s = await start();
  const { author, id } = await quizCourse(s);
  const learner = await s.as("learner");
  assert.equal((await learner(`/api/admin/courses/${id}/images`, { method: "POST", body: { data: b64(PNG) } })).status, 403);
  for (const data of [b64(Buffer.from("<svg><script>1</script></svg>")), "not base64!!", undefined])
    assert.equal((await author(`/api/admin/courses/${id}/images`, { method: "POST", body: { data } })).status, 400);
  assert.equal((await author(`/api/admin/courses/9999/images`, { method: "POST", body: { data: b64(PNG) } })).status, 404);

  const up = await author(`/api/admin/courses/${id}/images`, { method: "POST", body: { data: b64(PNG) } });
  assert.equal(up.status, 201);
  assert.match(up.body.url, /^\/media\/[A-Za-z0-9_-]{22}$/);
  assert.equal((await s.raw(up.body.url)).headers.get("content-type"), "image/png");

  const lesson = await author(`/api/admin/courses/${id}/lessons`, { method: "POST", body: { title: "With a picture", body: `<p>Look</p><img src="${up.body.url}" alt="A diagram">` } });
  assert.equal(lesson.status, 201);
  assert.match(lesson.body.body, /<img src="\/media\//);
  const view = (await learner(`/api/courses/${id}`)).body;
  assert.match(view.lessons.find(l => l.title === "With a picture").body, /alt="A diagram"/);

  await author(`/api/admin/courses/${id}/image`, { method: "PUT", body: { data: b64(PNG), alt: "Cover" } });       // set, then replace, the cover
  await author(`/api/admin/courses/${id}/image`, { method: "PUT", body: { data: b64(PNG), alt: "Cover 2" } });
  assert.equal((await s.raw(up.body.url)).status, 200);                                                         // the lesson image is untouched
  assert.equal(s.db.prepare("SELECT COUNT(*) FROM images WHERE kind = 'lesson'").pluck().get(), 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) FROM images WHERE kind = 'cover'").pluck().get(), 1);
  assert.equal((await author(`/api/admin/courses/${id}/image`, { method: "DELETE", body: {} })).status, 204);
  assert.equal((await s.raw(up.body.url)).status, 200);
  s.close();
});

test("lesson images: unused ones are cleaned up after an hour, never sooner; used ones stay; limits apply", async () => {
  const s = await start();
  const { author, id } = await quizCourse(s);
  const upload = async () => (await author(`/api/admin/courses/${id}/images`, { method: "POST", body: { data: b64(PNG) } })).body.url;
  const [used, oldUnused, freshUnused] = [await upload(), await upload(), await upload()];
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  s.db.prepare("UPDATE images SET created_at = ? WHERE key IN (?, ?)").run(old, used.slice(7), oldUnused.slice(7));
  await author(`/api/admin/courses/${id}/lessons`, { method: "POST", body: { title: "Uses one", body: `<p>x</p><img src="${used}" alt="">` } });   // saving a lesson triggers the cleanup
  assert.equal((await s.raw(used)).status, 200);            // old but in use
  assert.equal((await s.raw(oldUnused)).status, 404);       // old and unused: removed
  assert.equal((await s.raw(freshUnused)).status, 200);     // unused but new: the author may still be writing
  const lessonId = s.db.prepare("SELECT id FROM lessons WHERE title = 'Uses one'").pluck().get();
  await author(`/api/admin/lessons/${lessonId}`, { method: "DELETE" });
  assert.equal((await s.raw(used)).status, 404);            // the lesson is gone and the image was old, so it goes too
  assert.equal((await s.raw(freshUnused)).status, 200);     // the new one is still protected

  for (let i = 0; i < 60; i++) s.db.prepare("INSERT INTO images (key, course_id, kind, mime, bytes, size, created_at) VALUES (?, ?, 'lesson', 'image/png', ?, 10, ?)").run(`filler${i}`, id, PNG, new Date().toISOString());
  assert.equal((await author(`/api/admin/courses/${id}/images`, { method: "POST", body: { data: b64(PNG) } })).status, 409);
  s.close();
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
