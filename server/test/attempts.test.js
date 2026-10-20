import { test } from "node:test";
import assert from "node:assert/strict";
import { start, PW, publishedCourse, quizCourse, addLessons, lessonIds } from "./helpers.js";

test("attempts: scored on the server, pass mark applied, answers hidden until passed (default), history kept", async () => {
  const s = await start();
  const { id, answers } = await quizCourse(s);
  const learner = await s.as("learner");
  const fail = await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: answers(1) } });
  assert.equal(fail.status, 201);
  assert.deepEqual([fail.body.score, fail.body.total, fail.body.percent, fail.body.passed], [0, 3, 0, false]);
  assert.ok(fail.body.results.every(r => !("answer" in r) && !("explanation" in r))); // not revealed after a fail
  const pass = await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: answers(0) } });
  assert.deepEqual([pass.body.percent, pass.body.passed, pass.body.attemptsUsed], [100, true, 2]);
  assert.ok(pass.body.results.every(r => r.answer === 0)); // revealed once passed
  const list = (await learner(`/api/courses/${id}/attempts`)).body;
  assert.deepEqual([list.attemptsUsed, list.passed, list.attempts.map(a => a.percent)], [2, true, [100, 0]]);
  assert.ok("answer" in (await learner(`/api/attempts/${fail.body.id}`)).body.results[0]); // the old attempt is now reviewable
  assert.equal((await (await s.as("author"))(`/api/attempts/${fail.body.id}`)).status, 404); // not someone else's
  assert.deepEqual(
    (await learner("/api/grades")).body.map(g => [g.attempts, g.bestPercent, g.passed]),
    [[2, 100, true]],
  );
  s.close();
});

test("attempts: unanswered and out-of-range answers are wrong; attempt limit enforced; no quiz means 409", async () => {
  const s = await start();
  const { id, qids } = await quizCourse(s, { maxAttempts: 2, passMark: 50 });
  const learner = await s.as("learner");
  const partial = await learner(`/api/courses/${id}/quiz`, {
    method: "POST",
    body: { answers: { [qids[0]]: 0, [qids[1]]: 99, [qids[2]]: "0" } },
  });
  assert.deepEqual([partial.body.score, partial.body.percent, partial.body.passed], [1, 33, false]);
  await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: {} } });
  const third = await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: {} } });
  assert.equal(third.status, 409);
  assert.equal((await learner(`/api/courses/${id}/attempts`)).body.attemptsUsed, 2);

  const { author, id: empty } = await publishedCourse(s);
  await author(`/api/admin/courses/${empty}/enrolments`, {
    method: "POST",
    body: { emails: ["learner@example.com"] },
  });
  assert.equal(
    (await learner(`/api/courses/${empty}/quiz`, { method: "POST", body: { answers: {} } })).status,
    409,
  );
  s.close();
});

test("quiz settings are validated; showAnswers 'always' reveals straight away", async () => {
  const s = await start();
  const { author, id, answers } = await quizCourse(s, { showAnswers: "always" });
  for (const body of [
    { passMark: 101 },
    { passMark: "70" },
    { maxAttempts: 0 },
    { maxAttempts: 51 },
    { showAnswers: "sometimes" },
  ])
    assert.equal(
      (await author(`/api/admin/courses/${id}`, { method: "PATCH", body })).status,
      400,
      JSON.stringify(body),
    );
  assert.equal(
    (await author(`/api/admin/courses/${id}`, { method: "PATCH", body: { maxAttempts: null } })).status,
    200,
  );
  const r = await (
    await s.as("learner")
  )(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: answers(1) } });
  assert.ok(r.body.results.every(x => x.answer === 0));
  s.close();
});

test("gradebook: includes enrolled people with no attempts, summarises, ranks hard questions, staff only", async () => {
  const s = await start();
  const { author, id, qids, answers } = await quizCourse(s);
  await author(`/api/admin/courses/${id}/enrolments`, {
    method: "POST",
    body: { emails: ["admin@example.com"] },
  });
  const learner = await s.as("learner");
  await learner(`/api/courses/${id}/quiz`, {
    method: "POST",
    body: { answers: { ...answers(0), [qids[0]]: 1 } },
  }); // 2 of 3
  assert.equal((await learner(`/api/admin/courses/${id}/gradebook`)).status, 403);
  const g = (await author(`/api/admin/courses/${id}/gradebook`)).body;
  assert.deepEqual(g.summary, {
    enrolled: 2,
    attempted: 1,
    passed: 0,
    completed: 0,
    lessons: 1,
    averageBestPercent: 67,
  });
  assert.deepEqual(
    g.learners.map(l => [l.email, l.attempts, l.bestPercent, l.passed]),
    [
      ["admin@example.com", 0, null, false],
      ["learner@example.com", 1, 67, false],
    ],
  );
  assert.equal(g.questions[0].id, qids[0]); // the missed question ranks first
  assert.equal(g.questions[0].percentCorrect, 0);
  const lid = g.learners[1].userId;
  const detail = (await author(`/api/admin/courses/${id}/users/${lid}/attempts`)).body;
  assert.equal(detail.length, 1);
  assert.equal(detail[0].results[0].chosen, 1);
  s.close();
});

test("gradebook CSV defangs spreadsheet formulas and is staff only", async () => {
  const s = await start();
  const { id } = await quizCourse(s);
  const admin = await s.as("admin");
  const lid = s.db.prepare("SELECT id FROM users WHERE email = 'learner@example.com'").pluck().get();
  await admin(`/api/admin/users/${lid}`, { method: "PATCH", body: { name: '=HYPERLINK("http://x")' } });
  const res = await s.raw(`/api/admin/courses/${id}/gradebook.csv`, {
    cookie: await (async () => {
      const l = await s.parse(
        await s.raw("/api/auth/login", {
          method: "POST",
          body: { email: "author@example.com", password: PW },
        }),
      );
      return l.setCookie.split(";")[0];
    })(),
  });
  const csv = await res.text();
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"")"`), csv);
  assert.equal((await (await s.as("learner"))(`/api/admin/courses/${id}/gradebook.csv`)).status, 403);
});

test("completion: default rule needs every lesson done and the quiz passed; marking is idempotent and undoable", async () => {
  const s = await start();
  const { id, answers } = await quizCourse(s);
  addLessons(s, id, 1); // 2 lessons in total
  const learner = await s.as("learner");
  const [l1, l2] = await lessonIds(learner, id);
  let p = (await learner(`/api/courses/${id}/progress`)).body;
  assert.deepEqual(
    [p.rule, p.percent, p.completed, p.quiz],
    ["both", 0, false, { required: true, passed: false }],
  );

  assert.equal(
    (await learner(`/api/courses/${id}/lessons/${l1}/complete`, { method: "POST", body: {} })).body.percent,
    33,
  ); // 1 of 3 requirements
  assert.equal(
    (await learner(`/api/courses/${id}/lessons/${l1}/complete`, { method: "POST", body: {} })).body.percent,
    33,
  ); // again: no change
  await learner(`/api/courses/${id}/lessons/${l2}/complete`, { method: "POST", body: {} });
  p = (await learner(`/api/courses/${id}/progress`)).body;
  assert.deepEqual([p.percent, p.completed], [67, false]); // lessons done, quiz outstanding
  assert.equal(
    (await learner(`/api/courses/${id}/lessons/${l2}/complete`, { method: "DELETE" })).body.percent,
    33,
  ); // undo works

  await learner(`/api/courses/${id}/lessons/${l2}/complete`, { method: "POST", body: {} });
  await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: answers(0) } }); // passing completes the course
  p = (await learner(`/api/courses/${id}/progress`)).body;
  assert.deepEqual([p.percent, p.completed], [100, true]);
  assert.ok(p.completedAt);
  assert.deepEqual(
    (await learner("/api/courses")).body.map(c => [c.percent, c.completed]),
    [[100, true]],
  );
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
  await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: answers(0) } }); // quiz passed, no lessons yet
  assert.equal((await learner(`/api/courses/${id}/progress`)).body.completed, false); // lessons-only rule: not enough
  await author(`/api/admin/courses/${id}`, { method: "PATCH", body: { completion: "quiz" } }); // now the quiz alone qualifies
  assert.equal((await learner(`/api/courses/${id}/progress`)).body.completed, true);
  assert.equal(
    (await author(`/api/admin/courses/${id}`, { method: "PATCH", body: { completion: "never" } })).status,
    400,
  );

  const second = await quizCourse(s, { completion: "lessons" }); // lessons-only completes with no quiz taken
  const [m1] = await lessonIds(learner, second.id);
  assert.equal(
    (await learner(`/api/courses/${second.id}/lessons/${m1}/complete`, { method: "POST", body: {} })).body
      .completed,
    true,
  );
  s.close();
});

test("completion access: lessons must belong to the course; staff preview and non-enrolled people can't track progress", async () => {
  const s = await start();
  const a = await quizCourse(s),
    b = await quizCourse(s);
  const learner = await s.as("learner"),
    author = await s.as("author");
  const [bLesson] = await lessonIds(learner, b.id);
  assert.equal(
    (await learner(`/api/courses/${a.id}/lessons/${bLesson}/complete`, { method: "POST", body: {} })).status,
    404,
  ); // another course's lesson
  assert.equal(
    (await learner(`/api/courses/${a.id}/lessons/9999/complete`, { method: "POST", body: {} })).status,
    404,
  );
  const [aLesson] = await lessonIds(learner, a.id);
  assert.equal(
    (await author(`/api/courses/${a.id}/lessons/${aLesson}/complete`, { method: "POST", body: {} })).status,
    403,
  ); // staff preview
  const ghost = await publishedCourse(s); // learner isn't enrolled here
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
  const login = await s.parse(
    await s.raw("/api/auth/login", { method: "POST", body: { email: "author@example.com", password: PW } }),
  );
  const csv = await (
    await s.raw(`/api/admin/courses/${id}/gradebook.csv`, { cookie: login.setCookie.split(";")[0] })
  ).text();
  assert.match(csv.split("\r\n")[0], /Completed/);
  s.close();
});
