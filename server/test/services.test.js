import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../db.js";
import { HttpError, now } from "../http.js";
import { hashPassword } from "../auth.js";
import { createCourses } from "../services/courses.js";
import { createEnrolment } from "../services/enrolment.js";
import { createQuestionAdmin } from "../services/question-admin.js";
import { insertQuestion, cleanQuestion } from "../question-types/index.js";

// These tests call the services directly: no server, no HTTP, no cookies.
async function setup() {
  const db = openDb(":memory:");
  const hash = await hashPassword("whatever-long-password");
  for (const email of ["a@example.com", "b@example.com"])
    db.prepare("INSERT INTO users (email, role, password_hash, created_at) VALUES (?, 'learner', ?, ?)").run(
      email,
      hash,
      now(),
    );
  db.prepare(
    "INSERT INTO users (email, role, password_hash, created_at, active) VALUES ('gone@example.com', 'learner', ?, ?, 0)",
  ).run(hash, now());
  const courses = createCourses(db);
  const id = db
    .prepare("INSERT INTO courses (title, created_at, updated_at) VALUES ('Safety', ?, ?)")
    .run(now(), now()).lastInsertRowid;
  return { db, courses, enrolment: createEnrolment(db), course: courses.need(id) };
}

/** Runs `fn` and returns the HttpError it threw, so a test can check the status and the words. */
const failure = fn => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof HttpError, `expected an HttpError, got ${err}`);
    return { status: err.status, message: err.message };
  }
  return assert.fail("expected an error");
};

test("courses service: a missing course is a 404 with a plain message", async () => {
  const { courses } = await setup();
  assert.deepEqual(
    failure(() => courses.need(999)),
    { status: 404, message: "Course not found" },
  );
  assert.equal(courses.get(999), undefined);
});

test("courses service: settings are checked, and only real changes are reported", async () => {
  const { courses, course } = await setup();
  const bad = body => failure(() => courses.updateSettings(course, body));
  assert.equal(bad({ title: "   " }).message, "A course needs a title");
  assert.equal(bad({ enrolment: "sometimes" }).message, "Enrolment must be manual or open");
  assert.equal(bad({ passMark: 101 }).message, "Pass mark must be a whole number from 0 to 100");
  assert.equal(bad({ passMark: 70.5 }).status, 400);
  assert.equal(bad({ maxAttempts: 0 }).message, "Max attempts must be 1 to 50, or null for unlimited");
  assert.equal(bad({ certificate: "yes" }).message, "certificate must be true or false");
  assert.equal(bad({ completion: "never" }).message, "completion must be lessons, quiz or both");
  assert.equal(bad({ showAnswers: "sometimes" }).message, "showAnswers must be never, after_pass or always");

  const first = courses.updateSettings(course, { passMark: 85, maxAttempts: 2, certificate: false });
  assert.deepEqual(first.changed, {
    pass_mark: { from: 70, to: 85 },
    max_attempts: { from: null, to: 2 },
    certificate_enabled: { from: 1, to: 0 },
  });
  assert.deepEqual([first.settings.passMark, first.settings.certificate], [85, false]);
  assert.deepEqual(courses.updateSettings(courses.need(course.id), { passMark: 85 }).changed, {}); // nothing changed
  assert.equal(
    courses.updateSettings(courses.need(course.id), { maxAttempts: null }).settings.maxAttempts,
    null,
  ); // null means unlimited
});

test("courses service: publishing needs a lesson", async () => {
  const { db, courses, course } = await setup();
  assert.deepEqual(
    failure(() => courses.publish(course)),
    { status: 400, message: "Add at least one lesson first" },
  );
  db.prepare("INSERT INTO lessons (course_id, position, title, body) VALUES (?, 0, 'L', '<p>x</p>')").run(
    course.id,
  );
  courses.publish(course);
  assert.equal(courses.need(course.id).status, "published");
});

test("courses service: learners get no answer key and no draft questions", async () => {
  const { db, courses, course } = await setup();
  insertQuestion(
    db,
    course.id,
    0,
    cleanQuestion({ prompt: "Q1?", options: ["a", "b"], answer: 1 }).value,
    "manual",
    "approved",
  );
  insertQuestion(
    db,
    course.id,
    1,
    cleanQuestion({ prompt: "Q2?", options: ["a", "b"], answer: 0 }).value,
    "ai",
    "draft",
  );
  const view = courses.learnerView(course);
  assert.deepEqual(
    view.questions.map(q => q.prompt),
    ["Q1?"],
  );
  assert.ok(!("answer" in view.questions[0]));
  assert.equal(courses.adminDetail(course).questions.length, 2); // staff see both, with the key
  assert.equal(courses.adminDetail(course).questions[0].answer, 1);
});

test("enrolment service: reports who was enrolled, already enrolled, or not found; ignores case and repeats", async () => {
  const { enrolment, course } = await setup();
  assert.deepEqual(
    enrolment.enrolEmails(
      course,
      ["A@example.com", "a@example.com", "ghost@example.com", "gone@example.com"],
      null,
    ),
    {
      enrolled: ["a@example.com"],
      alreadyEnrolled: [],
      notFound: ["ghost@example.com", "gone@example.com"], // an inactive account counts as not found
    },
  );
  assert.deepEqual(enrolment.enrolEmails(course, ["a@example.com", "b@example.com"], null), {
    enrolled: ["b@example.com"],
    alreadyEnrolled: ["a@example.com"],
    notFound: [],
  });
  assert.deepEqual(
    enrolment.list(course.id).map(p => [p.email, p.self_enrolled]),
    [
      ["a@example.com", true],
      ["b@example.com", true],
    ],
  );
  for (const bad of [[], "a@example.com", [1], Array(501).fill("a@example.com")])
    assert.equal(failure(() => enrolment.enrolEmails(course, bad, null)).status, 400);
});

test("enrolment service: removing someone returns their email; removing a stranger is a 404; self-enrol needs an open published course", async () => {
  const { db, courses, enrolment, course } = await setup();
  enrolment.enrolEmails(course, ["a@example.com"], null);
  const aId = db.prepare("SELECT id FROM users WHERE email = 'a@example.com'").pluck().get();
  assert.equal(enrolment.unenrol(course.id, aId), "a@example.com");
  assert.equal(failure(() => enrolment.unenrol(course.id, aId)).status, 404);

  assert.equal(failure(() => enrolment.selfEnrol(course, aId)).status, 404); // a draft, and manual
  db.prepare("UPDATE courses SET status = 'published', enrolment = 'open' WHERE id = ?").run(course.id);
  enrolment.selfEnrol(courses.need(course.id), aId);
  assert.equal(enrolment.isEnrolled(course.id, aId), true);
  enrolment.selfEnrol(courses.need(course.id), aId); // joining twice is harmless
  assert.equal(enrolment.list(course.id).length, 1);
});

test("question admin service: edits replace what is sent, type changes need their own fields, drafts can be approved", async () => {
  const { db, courses, course } = await setup();
  const questions = createQuestionAdmin(db, courses);
  const id = insertQuestion(
    db,
    course.id,
    0,
    cleanQuestion({ type: "numeric", prompt: "How many?", value: 5, tolerance: 0 }).value,
    "ai",
  );
  assert.equal(questions.update(id, { tolerance: 1 }).tolerance, 1);
  assert.equal(questions.update(id, { status: "approved" }).status, "approved");
  assert.equal(failure(() => questions.update(id, { status: "maybe" })).status, 400);
  assert.equal(
    failure(() => questions.update(id, { type: "short_answer" })).message,
    "Give at least one accepted answer.",
  );
  assert.deepEqual(questions.update(id, { type: "short_answer", accepted: ["five"] }).accepted, ["five"]);
  assert.equal(failure(() => questions.update(9999, {})).status, 404);
  questions.remove(id);
  assert.equal(failure(() => questions.remove(id)).status, 404);
});
