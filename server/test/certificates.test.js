import { test } from "node:test";
import assert from "node:assert/strict";
import { start, quizCourse, complete, addUser, loginAs } from "./helpers.js";

test("certificates: issued on completion with a unique code per learner; one per learner per course", async () => {
  const s = await start();
  const { author, id, answers } = await quizCourse(s);
  await addUser(s, "second@example.com", "Second Person");
  await author(`/api/admin/courses/${id}/enrolments`, {
    method: "POST",
    body: { emails: ["second@example.com"] },
  });
  const one = await s.as("learner"),
    two = await loginAs(s, "second@example.com");

  assert.equal((await one(`/api/courses/${id}/certificate`)).status, 404); // not completed yet
  assert.deepEqual((await one("/api/certificates")).body, []);
  await complete(one, id, answers);
  await complete(two, id, answers);
  const a = (await one(`/api/courses/${id}/certificate`)).body,
    b = (await two(`/api/courses/${id}/certificate`)).body;
  assert.match(a.code, /^LL-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
  assert.notEqual(a.code, b.code);
  assert.equal(b.recipientName, "Second Person");
  assert.equal(a.recipientName, "learner@example.com"); // no name set: falls back to email
  await complete(one, id, answers); // completing again changes nothing
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
  assert.equal(cert.recipientName, "Sam img src=x onerror=alert(1)"); // angle brackets stripped on the way in

  const ok = await s.parse(
    await s.raw(`/api/verify/${encodeURIComponent(" " + cert.code.toLowerCase() + " ")}`),
  );
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
  assert.equal(
    (await learner(`/api/admin/certificates/${cid}`, { method: "PATCH", body: { revoked: true } })).status,
    403,
  );
  assert.equal(
    (await author(`/api/admin/certificates/${cid}`, { method: "PATCH", body: { recipientName: "  " } }))
      .status,
    400,
  );
  await author(`/api/admin/certificates/${cid}`, {
    method: "PATCH",
    body: { recipientName: "Alex Example" },
  });
  await author(`/api/admin/certificates/${cid}`, {
    method: "PATCH",
    body: { revoked: true, reason: "Issued in error" },
  });
  const v = (await s.parse(await s.raw(`/api/verify/${list[0].code}`))).body;
  assert.deepEqual([v.valid, v.revoked, v.recipientName], [false, true, "Alex Example"]);
  assert.match(await (await s.raw(`/certificate/${list[0].code}`)).text(), /revoked/);
  assert.equal(
    (await author(`/api/admin/courses/${id}/certificates`)).body[0].revokedReason,
    "Issued in error",
  );
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
  assert.equal(
    (await author(`/api/admin/courses/${id}`, { method: "PATCH", body: { certificate: "yes" } })).status,
    400,
  );
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
