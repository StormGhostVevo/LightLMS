import { test } from "node:test";
import assert from "node:assert/strict";
import { start, quizCourse, complete, publishedCourse, PW } from "./helpers.js";
import { createEvents, target } from "../events.js";
import { readAudit } from "../audit.js";

/** The audit log as an admin sees it, oldest first. */
const trail = async (/** @type {import("./helpers.js").TestApp} */ s) => {
  const admin = await s.as("admin");
  return (await admin("/api/admin/audit?limit=200")).body.entries.reverse();
};
const actions = entries => entries.map(e => e.action);

test("audit: user management is recorded with who did it, and never the passwords", async () => {
  const s = await start();
  const admin = await s.as("admin");
  const made = (
    await admin("/api/admin/users", { method: "POST", body: { email: "new@example.com", role: "author" } })
  ).body;
  const id = made.id;
  await admin(`/api/admin/users/${id}`, { method: "PATCH", body: { role: "learner" } });
  await admin(`/api/admin/users/${id}`, { method: "PATCH", body: { active: false } });
  await admin(`/api/admin/users/${id}`, { method: "PATCH", body: { active: true } });
  const reset = (await admin(`/api/admin/users/${id}`, { method: "PATCH", body: { resetPassword: true } }))
    .body;
  const log = await trail(s);
  assert.deepEqual(actions(log), [
    "user.created",
    "user.role_changed",
    "user.deactivated",
    "user.reactivated",
    "user.password_reset",
  ]);
  assert.equal(log[0].actor, "admin@example.com");
  assert.deepEqual(log[0].target, { type: "user", id: String(id), label: "new@example.com" });
  assert.deepEqual(log[1].detail, { from: "author", to: "learner" });
  const everything = JSON.stringify(log);
  for (const secret of [made.temporaryPassword, reset.temporaryPassword, PW, "scrypt$"])
    assert.ok(!everything.includes(secret), `leaked ${secret.slice(0, 6)}`);
  s.close();
});

test("audit: a person changing their own password is recorded; a failed attempt is not", async () => {
  const s = await start();
  const learner = await s.as("learner");
  await learner("/api/auth/password", {
    method: "POST",
    body: { current: "wrong-wrong-wrong", next: "a-new-long-password" },
  });
  assert.deepEqual(actions(await trail(s)), []);
  await learner("/api/auth/password", { method: "POST", body: { current: PW, next: "a-new-long-password" } });
  const log = await trail(s);
  assert.deepEqual([log[0].action, log[0].actor], ["user.password_changed", "learner@example.com"]);
  s.close();
});

test("audit: course changes, with only the settings that actually changed", async () => {
  const s = await start();
  const author = await s.as("author");
  const { body: made } = await author("/api/admin/courses", {
    method: "POST",
    body: { title: "Handling complaints" },
  });
  await author(`/api/admin/courses/${made.id}/lessons`, {
    method: "POST",
    body: { title: "L", body: "<p>x</p>" },
  });
  await author(`/api/admin/courses/${made.id}`, {
    method: "PATCH",
    body: { passMark: 80, maxAttempts: 3, title: "Handling complaints" },
  });
  await author(`/api/admin/courses/${made.id}`, { method: "PATCH", body: { passMark: 80 } }); // nothing changed: nothing recorded
  await author(`/api/admin/courses/${made.id}/publish`, { method: "POST", body: {} });
  await author(`/api/admin/courses/${made.id}/unpublish`, { method: "POST", body: {} });
  await author(`/api/admin/courses/${made.id}`, { method: "DELETE" });
  const log = await trail(s);
  assert.deepEqual(actions(log), [
    "course.created",
    "course.settings_changed",
    "course.published",
    "course.unpublished",
    "course.deleted",
  ]);
  assert.deepEqual(log[1].detail, { pass_mark: { from: 70, to: 80 }, max_attempts: { from: null, to: 3 } });
  assert.ok(log.every(e => e.actor === "author@example.com" && e.target.label === "Handling complaints"));
  s.close();
});

test("audit: enrolment, certificates, theme and AI use are recorded", async () => {
  const s = await start();
  const { author, id, answers } = await quizCourse(s); // the learner is enrolled here, by the author
  const learner = await s.as("learner");
  await complete(learner, id, answers);
  const cert = (await author(`/api/admin/courses/${id}/certificates`)).body[0];
  await author(`/api/admin/certificates/${cert.id}`, {
    method: "PATCH",
    body: { recipientName: "Corrected Name" },
  });
  await author(`/api/admin/certificates/${cert.id}`, {
    method: "PATCH",
    body: { revoked: true, reason: "Issued in error" },
  });
  await author(`/api/admin/certificates/${cert.id}`, { method: "PATCH", body: { revoked: false } });
  const learnerId = s.db.prepare("SELECT id FROM users WHERE email = 'learner@example.com'").pluck().get();
  await author(`/api/admin/courses/${id}/enrolments/${learnerId}`, { method: "DELETE" });
  const admin = await s.as("admin");
  await admin("/api/admin/theme", { method: "PUT", body: { font: "serif", fontSize: "large" } });
  await admin("/api/admin/theme", { method: "DELETE", body: {} });
  const log = await trail(s);
  const names = actions(log);
  for (const expected of [
    "ai.course_drafted",
    "ai.quiz_generated",
    "enrolment.added",
    "certificate.name_changed",
    "certificate.revoked",
    "certificate.restored",
    "enrolment.removed",
    "theme.changed",
    "theme.reset",
  ])
    assert.ok(names.includes(expected), `missing ${expected} in ${names.join(", ")}`);
  assert.equal(log.find(e => e.action === "certificate.revoked").detail.reason, "Issued in error");
  assert.deepEqual(log.find(e => e.action === "enrolment.removed").detail, { person: "learner@example.com" });
  assert.deepEqual(log.find(e => e.action === "theme.changed").detail, {
    font: "serif",
    fontSize: "large",
    customColours: false,
  });
  s.close();
});

test("audit: only admins can read it, and it can be paged and filtered", async () => {
  const s = await start();
  const author = await s.as("author");
  assert.equal((await (await s.as(null))("/api/admin/audit")).status, 401);
  assert.equal((await (await s.as("learner"))("/api/admin/audit")).status, 403);
  assert.equal((await author("/api/admin/audit")).status, 403);

  for (let i = 0; i < 7; i++)
    await author("/api/admin/courses", { method: "POST", body: { title: `Course ${i}` } });
  await publishedCourse(s); // adds ai.course_drafted and course.published
  const admin = await s.as("admin");
  const first = (await admin("/api/admin/audit?limit=5")).body;
  assert.equal(first.entries.length, 5);
  assert.ok(first.next);
  assert.ok(first.entries[0].id > first.entries[4].id); // newest first
  const second = (await admin(`/api/admin/audit?limit=5&before=${first.next}`)).body;
  assert.ok(second.entries.every(e => e.id < first.next));
  assert.equal(second.entries.length, 4); // 9 entries in all: 7 + 2
  assert.equal(second.next, null);
  const only = (await admin("/api/admin/audit?action=course.created")).body.entries;
  assert.equal(only.length, 7);
  assert.ok(only.every(e => e.action === "course.created"));
  assert.equal((await admin("/api/admin/audit?limit=100000")).status, 200); // an absurd limit is clamped, not an error
  s.close();
});

test("audit: the record outlives the account it names", async () => {
  const s = await start();
  const author = await s.as("author");
  await author("/api/admin/courses", { method: "POST", body: { title: "Kept" } });
  s.db.prepare("DELETE FROM users WHERE email = 'author@example.com'").run();
  const { entries } = readAudit(s.db);
  assert.deepEqual([entries[0].actor, entries[0].target.label], ["author@example.com", "Kept"]);
  s.close();
});

test("events: a failing observer never breaks the others or the caller", () => {
  const events = createEvents();
  const seen = [];
  const original = console.error;
  console.error = () => {};
  events.observe(() => {
    throw new Error("boom");
  });
  events.observe((name, e) => seen.push([name, e.target?.label]));
  try {
    events.emit("thing.happened", { target: target("thing", 1, "Widget") });
  } finally {
    console.error = original;
  }
  assert.deepEqual(seen, [["thing.happened", "Widget"]]);
});
