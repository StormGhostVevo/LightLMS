import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, quizCourse, complete, addUser, loginAs, PW } from "./helpers.js";
import { openDb } from "../db.js";
import { createPrivacy } from "../services/privacy.js";
import { HttpError } from "../http.js";
import { openBrowser } from "./browser-helpers.js";
import { usersView } from "../../public/js/views/manage/users.js";

/** A learner with a full history: enrolled, lessons done, a quiz taken, a certificate earned, a name set. */
async function withHistory() {
  const s = await start();
  const { author, id, answers } = await quizCourse(s);
  const learner = await s.as("learner");
  await learner("/api/auth/me", { method: "PATCH", body: { name: "Riley Participant" } });
  await complete(learner, id, answers);
  const code = (await learner(`/api/courses/${id}/certificate`)).body.code;
  // Someone else with their own history, who must be left alone by anything done to the first.
  await addUser(s, "bystander@example.com", "Bea Bystander");
  await author(`/api/admin/courses/${id}/enrolments`, {
    method: "POST",
    body: { emails: ["bystander@example.com"] },
  });
  const bystander = await loginAs(s, "bystander@example.com");
  await complete(bystander, id, answers);
  const admin = await s.as("admin");
  const learnerId = s.db.prepare("SELECT id FROM users WHERE email = 'learner@example.com'").pluck().get();
  return { s, author, admin, id, code, learnerId, bystander };
}

test("export: everything held about a person, and never their password or session", async () => {
  const { s, admin, learnerId, code } = await withHistory();
  const res = await admin(`/api/admin/users/${learnerId}/export`);
  assert.equal(res.status, 200);
  const d = res.body;
  assert.deepEqual(
    [d.profile.email, d.profile.name, d.profile.role],
    ["learner@example.com", "Riley Participant", "learner"],
  );
  assert.equal(d.enrolments.length, 1);
  assert.ok(d.lessonsMarkedDone.length >= 1);
  assert.equal(d.courseCompletions.length, 1);
  assert.equal(d.quizAttempts.length, 1);
  assert.deepEqual([d.quizAttempts[0].percent, d.quizAttempts[0].passed], [100, true]);
  assert.ok(d.quizAttempts[0].answers.length >= 1 && "question" in d.quizAttempts[0].answers[0]);
  assert.equal(d.certificates[0].code, code);
  assert.ok(typeof d.exportedAt === "string");
  const text = JSON.stringify(d);
  for (const secret of ["scrypt$", "password_hash", "id_hash"]) assert.ok(!text.includes(secret), secret);

  const raw = await s.raw(`/api/admin/users/${learnerId}/export`, {
    cookie: (
      await s.parse(
        await s.raw("/api/auth/login", {
          method: "POST",
          body: { email: "admin@example.com", password: PW },
        }),
      )
    ).setCookie.split(";")[0],
  });
  assert.match(raw.headers.get("content-disposition"), /attachment; filename="person-\d+-data\.json"/);
  assert.equal(raw.headers.get("cache-control"), "no-store");
  assert.equal((await admin("/api/admin/users/9999/export")).status, 404);
  const log = (await admin("/api/admin/audit?limit=50")).body.entries;
  assert.ok(log.some(e => e.action === "user.data_exported"));
  s.close();
});

test("export and erase are admin-only", async () => {
  const { s, learnerId } = await withHistory();
  /** @type {("author" | "learner")[]} */
  const outsiders = ["author", "learner"];
  for (const who of outsiders) {
    const call = await s.as(who);
    assert.equal((await call(`/api/admin/users/${learnerId}/export`)).status, 403, who);
    assert.equal(
      (
        await call(`/api/admin/users/${learnerId}/erase`, {
          method: "POST",
          body: { confirm: "learner@example.com" },
        })
      ).status,
      403,
      who,
    );
  }
  assert.equal((await (await s.as(null))(`/api/admin/users/${learnerId}/export`)).status, 401);
  s.close();
});

test("erase: the person's data is gone, the account is an empty shell, and nobody else is touched", async () => {
  const { s, admin, author, id, code, learnerId, bystander } = await withHistory();
  const learner = await s.as("learner");
  const before = (await author(`/api/admin/courses/${id}/gradebook`)).body;
  const bystanderBefore = before.learners.find(l => l.email === "bystander@example.com");

  const refused = await admin(`/api/admin/users/${learnerId}/erase`, {
    method: "POST",
    body: { confirm: "someone-else@example.com" },
  });
  assert.deepEqual(
    [refused.status, refused.body.error],
    [400, "Type the person's email address to confirm."],
  );
  assert.equal(
    (await admin(`/api/admin/users/${learnerId}/erase`, { method: "POST", body: {} })).status,
    400,
  );

  const done = await admin(`/api/admin/users/${learnerId}/erase`, {
    method: "POST",
    body: { confirm: "  LEARNER@example.com " },
  });
  assert.equal(done.status, 200);
  assert.ok(done.body.removed.quizAttempts >= 1 && done.body.removed.enrolments === 1);

  // They are signed out, can't sign in, and the account holds nothing.
  assert.equal((await learner("/api/auth/me")).status, 401);
  assert.equal(
    (
      await s.parse(
        await s.raw("/api/auth/login", {
          method: "POST",
          body: { email: "learner@example.com", password: PW },
        }),
      )
    ).status,
    401,
  );
  const row = /** @type {any} */ (s.db.prepare("SELECT * FROM users WHERE id = ?").get(learnerId));
  assert.deepEqual(
    [row.email, row.name, row.role, row.active, row.last_login_at],
    [`erased-${learnerId}@erased.invalid`, "", "learner", 0, null],
  );
  for (const table of ["sessions", "enrolments", "lesson_progress", "course_completions", "attempts"])
    assert.equal(
      s.db.prepare(`SELECT COUNT(*) FROM ${table} WHERE user_id = ?`).pluck().get(learnerId),
      0,
      table,
    );

  // The certificate still verifies, without the name.
  const cert = (await s.parse(await s.raw(`/api/verify/${code}`))).body;
  assert.deepEqual([cert.valid, cert.recipientName], [true, "Name removed"]);

  // The gradebook lost them and kept everyone else exactly as they were.
  const after = (await author(`/api/admin/courses/${id}/gradebook`)).body;
  assert.ok(!after.learners.some(l => l.email.startsWith("learner") || l.email.startsWith("erased")));
  assert.deepEqual(
    after.learners.find(l => l.email === "bystander@example.com"),
    bystanderBefore,
  );
  assert.equal((await bystander("/api/auth/me")).status, 200);
  assert.equal((await bystander("/api/courses")).body.length, 1);

  assert.equal(
    (
      await admin(`/api/admin/users/${learnerId}/erase`, {
        method: "POST",
        body: { confirm: `erased-${learnerId}@erased.invalid` },
      })
    ).status,
    409,
  ); // already done
  s.close();
});

test("erase: not one trace of the person's email or name is left anywhere in the database", async () => {
  const { s, admin, author, id, learnerId } = await withHistory();
  // Give the audit log plenty of reasons to have written their details down.
  await author(`/api/admin/courses/${id}/enrolments/${learnerId}`, { method: "DELETE" }); // "removed learner@example.com"
  const cert = (await author(`/api/admin/courses/${id}/certificates`)).body.find(
    c => c.recipientName === "Riley Participant",
  );
  await author(`/api/admin/certificates/${cert.id}`, {
    method: "PATCH",
    body: { recipientName: "Riley P. Participant" },
  }); // names in details
  await author(`/api/admin/certificates/${cert.id}`, {
    method: "PATCH",
    body: { revoked: true, reason: "test" },
  });
  await admin("/api/admin/users", { method: "PATCH" });
  await admin(`/api/admin/users/${learnerId}`, { method: "PATCH", body: { role: "author" } }); // "changed learner@example.com's role"
  await admin(`/api/admin/users/${learnerId}`, { method: "PATCH", body: { role: "learner" } });

  await admin(`/api/admin/users/${learnerId}/erase`, {
    method: "POST",
    body: { confirm: "learner@example.com" },
  });
  const tables = s.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .pluck()
    .all();
  for (const table of tables) {
    const dump = JSON.stringify(s.db.prepare(`SELECT * FROM ${table}`).all());
    for (const trace of ["learner@example.com", "Riley Participant", "Riley P. Participant"])
      assert.ok(!dump.includes(trace), `"${trace}" is still in ${table}`);
  }
  // The log still says that an erasure happened, and who did it.
  const log = (await admin("/api/admin/audit?limit=100")).body.entries;
  const erased = log.find(e => e.action === "user.erased");
  assert.equal(erased.actor, "admin@example.com");
  assert.equal(erased.target.label, `erased-${learnerId}@erased.invalid`);
  s.close();
});

test("erase: you can't erase yourself or the last active admin", async () => {
  const s = await start();
  const admin = await s.as("admin");
  const adminId = s.db.prepare("SELECT id FROM users WHERE email = 'admin@example.com'").pluck().get();
  const me = await admin(`/api/admin/users/${adminId}/erase`, {
    method: "POST",
    body: { confirm: "admin@example.com" },
  });
  assert.deepEqual([me.status, me.body.error], [409, "You can't erase your own account."]);

  // With a second admin, the first can be erased by the second, but then the second is the last one.
  const second = await admin("/api/admin/users", {
    method: "POST",
    body: { email: "admin2@example.com", role: "admin" },
  });
  const privacy = createPrivacy(s.db);
  privacy.erasePerson(adminId, { allowSelf: true }); // as the command line does
  assert.throws(
    () => privacy.erasePerson(second.body.id, { allowSelf: true }),
    err => err instanceof HttpError && /last active admin/.test(err.message),
  );
  s.close();
});

test("the people page offers export and erase, and erasing needs the email typed", async () => {
  const { s } = await withHistory();
  const b = openBrowser(s);
  try {
    await b.signIn("admin@example.com", PW);
    await b.show(usersView, { user: { role: "admin", email: "admin@example.com" } });
    await b.until(() => b.$$("tbody tr").length >= 4, "the user list");
    const row = b.$$("tbody tr").find(r => r.textContent.includes("learner@example.com"));
    assert.ok(row.querySelector('a[download][href$="/export"]'), "an export link");

    b.dialogs.prompt = () => "wrong@example.com"; // a wrong confirmation
    row.querySelector('button[aria-label="Erase learner@example.com"]').click();
    await b.until(() => /Type the person's email address to confirm/.test(b.text()), "the refusal");

    b.dialogs.prompt = () => "learner@example.com";
    b.$$("tbody tr")
      .find(r => r.textContent.includes("learner@example.com"))
      .querySelector('button[aria-label="Erase learner@example.com"]')
      .click();
    await b.until(() => /That person has been erased/.test(b.text()), "the confirmation");
    assert.ok(!b.text().includes("learner@example.com"));
    assert.match(b.text(), /erased-\d+@erased\.invalid/);
    await b.settled();
  } finally {
    b.close();
    s.close();
  }
});

test("command line: export prints JSON, erase says what it would do until told --yes, then erases and records it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lightlms-privacy-"));
  try {
    const dbPath = join(dir, "lightlms.sqlite");
    const env = {
      ...process.env,
      DATABASE_PATH: dbPath,
      BACKUP_DIR: join(dir, "backups"),
      NODE_ENV: "development",
      LOG_LEVEL: "silent",
    };
    const db = openDb(dbPath, { backupDir: null });
    db.prepare(
      "INSERT INTO users (email, name, role, password_hash, created_at) VALUES ('boss@example.com', 'Boss', 'admin', 'x', ?)",
    ).run(new Date().toISOString());
    db.prepare(
      "INSERT INTO users (email, name, role, password_hash, created_at) VALUES ('gone@example.com', 'Gone Person', 'learner', 'x', ?)",
    ).run(new Date().toISOString());
    db.close();
    const run = (...args) =>
      spawnSync(process.execPath, ["server/privacy-cli.js", ...args], { env, encoding: "utf8" });

    const exported = run("export", "gone@example.com");
    assert.equal(exported.status, 0, exported.stderr);
    assert.equal(JSON.parse(exported.stdout).profile.name, "Gone Person");

    const dry = run("erase", "gone@example.com");
    assert.equal(dry.status, 0);
    assert.match(dry.stdout, /would erase gone@example\.com.*Run it again with --yes/s);
    assert.equal(JSON.parse(run("export", "gone@example.com").stdout).profile.name, "Gone Person"); // nothing happened yet

    const done = run("erase", "gone@example.com", "--yes");
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /Erased person/);
    const check = openDb(dbPath, { backupDir: null });
    assert.match(String(check.prepare("SELECT email FROM users WHERE id = 2").pluck().get()), /^erased-2@/);
    assert.equal(
      check.prepare("SELECT actor_email FROM audit_log WHERE action = 'user.erased'").pluck().get(),
      "command line",
    );
    check.close();

    assert.equal(run("erase", "nobody@example.com", "--yes").status, 1);
    assert.equal(run("export").status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
