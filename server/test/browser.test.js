import { test } from "node:test";
import assert from "node:assert/strict";
import { start, quizCourse, publishedCourse, ONE_OF_EACH, PW } from "./helpers.js";
import { openBrowser } from "./browser-helpers.js";
import { loginView } from "../../public/js/views/login.js";
import { coursesView } from "../../public/js/views/courses.js";
import { courseView } from "../../public/js/views/course.js";
import { gradesView } from "../../public/js/views/grades.js";
import { accountView } from "../../public/js/views/account.js";
import { manageView } from "../../public/js/views/manage/index.js";
import { manageCourseView } from "../../public/js/views/manage/course.js";
import { usersView } from "../../public/js/views/manage/users.js";
import { themeView } from "../../public/js/views/manage/theme.js";
import { auditView } from "../../public/js/views/manage/audit.js";

const user = role => ({ email: `${role}@example.com`, name: "", role });

/** Runs a test body with a pretend browser, and always puts the globals back. */
const withBrowser = async (s, fn) => {
  const b = openBrowser(s);
  try {
    await fn(b);
  } finally {
    b.close();
    s.close();
  }
};

test("browser: sign-in shows the wrong-password message, then signs in", async () => {
  const s = await start();
  await withBrowser(s, async b => {
    /** @type {any} */
    let signedIn = null;
    b.main.append(loginView(u => (signedIn = u), "Acme"));
    assert.match(b.text(), /Acme/); // the site name is shown above the heading
    const [email, password] = b.$$("input");
    const form = b.$("form");

    b.fill(email, "learner@example.com");
    b.fill(password, "not-the-password");
    form.requestSubmit();
    await b.until(() => /Wrong email or password/.test(b.text()), "the wrong-password message");
    assert.equal(signedIn, null);
    assert.equal(password.value, ""); // cleared, ready for another try

    b.fill(password, PW);
    form.requestSubmit();
    await b.until(() => signedIn, "sign-in to finish");
    assert.equal(signedIn.email, "learner@example.com");
  });
});

test("browser: a learner's course list shows progress, and open courses they can join", async () => {
  const s = await start();
  const { author, id } = await quizCourse(s);
  const open = (await author("/api/admin/courses", { method: "POST", body: { title: "Open to all" } })).body
    .id;
  await author(`/api/admin/courses/${open}/lessons`, {
    method: "POST",
    body: { title: "L", body: "<p>x</p>" },
  });
  await author(`/api/admin/courses/${open}`, { method: "PATCH", body: { enrolment: "open" } });
  await author(`/api/admin/courses/${open}/publish`, { method: "POST", body: {} });

  await withBrowser(s, async b => {
    await b.signIn("learner@example.com", PW);
    await b.show(coursesView, { user: user("learner") });
    assert.ok(b.byText("a", "Safety basics"), b.text());
    assert.equal(b.$$("progress").length, 1);
    assert.match(b.text(), /Open courses/);
    assert.match(b.text(), /Open to all/);
    assert.ok(b.$(`a[href="#/course/${id}"]`));

    await b.press("Enrol");
    await b.until(() => b.window.location.hash === `#/course/${open}`, "the new course to open");
    await b.settled();
  });
});

test("browser: a learner works through a course: lessons, a quiz with every question type, the result, the certificate", async () => {
  const s = await start();
  const { author, id } = await publishedCourse(s);
  for (const q of Object.values(ONE_OF_EACH))
    await author(`/api/admin/courses/${id}/questions`, { method: "POST", body: q });
  await author(`/api/admin/courses/${id}/enrolments`, {
    method: "POST",
    body: { emails: ["learner@example.com"] },
  });
  await author(`/api/admin/courses/${id}`, { method: "PATCH", body: { showAnswers: "always" } });

  await withBrowser(s, async b => {
    await b.signIn("learner@example.com", PW);
    await b.show(courseView, { user: user("learner") }, [String(id)]);
    await b.settled();
    assert.match(b.text(), /To complete this course: mark every lesson as done and pass the quiz/);
    assert.equal(b.$(".progress-text").textContent, "0%");

    await b.press("Mark as done");
    await b.until(() => b.byText("button", "Done. Undo"), "the lesson to be ticked");
    assert.notEqual(b.$(".progress-text").textContent, "0%");

    // The quiz: one control of each kind. Submitting nothing is refused without using up an attempt.
    await b.press("Start the quiz");
    await b.until(() => b.$$(".quiz fieldset.question").length === 6, "six questions");
    await b.press("Submit answers");
    await b.until(
      () => /Answer every question before submitting \(6 left\)/.test(b.text()),
      "the validation message",
    );

    const q = b.$$(".quiz fieldset.question");
    q[0].querySelectorAll("input[type=radio]")[0].click(); // multiple choice: Paris
    q[1].querySelectorAll("input[type=radio]")[0].click(); // true or false: True
    for (const i of [0, 1, 3]) q[2].querySelectorAll("input[type=checkbox]")[i].click(); // select all: Red, Green, Blue
    b.fill(q[3].querySelector("input[type=text]"), "  au "); // short answer
    b.fill(q[4].querySelector("input[type=text]"), "12.5"); // number
    const selects = q[5].querySelectorAll("select");
    ["Paris", "Rome", "Madrid"].forEach((answer, i) => b.fill(selects[i], answer)); // matching
    await b.press("Submit answers");

    await b.until(() => /You scored/.test(b.text()), "the result");
    assert.match(b.text(), /You scored 6 of 6 \(100%\)/);
    assert.match(b.text(), /Passed\./);
    assert.match(b.text(), /Your answer: Red; Green; Blue/);
    assert.match(b.text(), /Your answer: Paris → ?|France → Paris/);
    await b.until(() => b.$('a[href^="/certificate/"]'), "the certificate link"); // completing the course earned it
    assert.equal(b.$(".progress-text").textContent, "100%");
    await b.settled();
  });
});

test("browser: a wrong quiz answer shows the correct one when the course allows it, and not when it doesn't", async () => {
  for (const [showAnswers, expectation] of [
    ["always", true],
    ["never", false],
  ]) {
    const s = await start();
    const { author, id } = await publishedCourse(s);
    await author(`/api/admin/courses/${id}/questions`, { method: "POST", body: ONE_OF_EACH.short_answer });
    await author(`/api/admin/courses/${id}/enrolments`, {
      method: "POST",
      body: { emails: ["learner@example.com"] },
    });
    await author(`/api/admin/courses/${id}`, { method: "PATCH", body: { showAnswers } });
    await withBrowser(s, async b => {
      await b.signIn("learner@example.com", PW);
      await b.show(courseView, { user: user("learner") }, [String(id)]);
      await b.press("Start the quiz");
      await b.until(() => b.$(".quiz input[type=text]"), "the question");
      b.fill(b.$(".quiz input[type=text]"), "Ag");
      await b.press("Submit answers");
      await b.until(() => /You scored/.test(b.text()), "the result");
      assert.match(b.text(), /Your answer: Ag/);
      assert.equal(
        /Correct answer: Au or gold symbol: Au/.test(b.text()),
        expectation,
        `showAnswers ${showAnswers}`,
      );
      assert.equal(/aren't shown/.test(b.text()), !expectation);
    });
  }
});

test("browser: grades and account pages show their data", async () => {
  const s = await start();
  const { id, answers } = await quizCourse(s);
  await withBrowser(s, async b => {
    await b.signIn("learner@example.com", PW);
    const call = (path, body) =>
      globalThis.fetch(`/api${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const lessons = (await (await globalThis.fetch(`/api/courses/${id}/progress`)).json()).lessons;
    for (const l of lessons) await call(`/courses/${id}/lessons/${l.id}/complete`, {});
    await call(`/courses/${id}/quiz`, { answers: answers(0) });

    await b.show(gradesView, { user: user("learner") });
    assert.match(b.text(), /Safety basics/);
    assert.match(b.text(), /100%/);
    assert.match(b.text(), /Passed/);

    await b.show(accountView, { user: user("learner") });
    assert.match(b.text(), /learner@example\.com/);
    assert.ok(b.$('a[href^="/certificate/"]'), "the earned certificate is listed");
    await b.settled();
  });
});

test("browser: every learner page loads without errors or stray text, empty and full", async () => {
  const s = await start();
  await withBrowser(s, async b => {
    await b.signIn("learner@example.com", PW);
    for (const [name, view] of [
      ["courses", coursesView],
      ["grades", gradesView],
      ["account", accountView],
    ]) {
      await b.show(view, { user: user("learner") });
      await b.settled();
      assert.ok(!b.$(".notice.error"), `${name}: ${b.text()}`);
    }
  });
});

test("browser: an author builds a course in the editor: create, add a lesson, add questions, publish", async () => {
  const s = await start();
  await withBrowser(s, async b => {
    await b.signIn("author@example.com", PW);
    await b.show(manageView, { user: user("author") });
    assert.match(b.text(), /Manage courses/);
    assert.equal(b.byText("a", "Manage users"), null, "an author is not offered user management");
    b.fill(b.$("form input[type=text]"), "Handling complaints");
    await b.press("Create course");
    await b.until(
      () => /#\/manage\/course\/\d+\/lessons/.test(b.window.location.hash),
      "the new course editor",
    );
    const id = /course\/(\d+)/.exec(b.window.location.hash)[1];

    await b.show(manageCourseView, { user: user("author") }, [id, "lessons"]);
    await b.until(() => /Lessons/.test(b.text()) && b.byText("button", "Add a lesson"), "the lessons tab");
    await b.press("Add a lesson");
    await b.until(() => b.$(".editor-area"), "the editor");
    b.fill(b.$("form.card input[type=text]"), "Listen first");
    b.$(".editor-area").innerHTML = "<p>Let them finish.</p>";
    await b.press("Add lesson");
    await b.until(() => b.byText("strong", "Listen first"), "the lesson to be listed");

    // A multiple-choice question, written by hand.
    await b.show(manageCourseView, { user: user("author") }, [id, "questions"]);
    await b.press("Add a question");
    await b.until(() => b.$("form.card select"), "the question form");
    b.fill(b.$("form.card textarea"), "What do you do first?");
    const rows = b.$$("form.card .option-row");
    b.fill(rows[0].querySelector("input[type=text]"), "Listen");
    b.fill(rows[1].querySelector("input[type=text]"), "Argue");
    await b.press("Add question");
    await b.until(
      () => /What do you do first\?/.test(b.text()) && /Listen \(correct\)/.test(b.text()),
      "the question to be listed",
    );

    // A matching question, to prove the form changes with the type.
    await b.press("Add a question");
    const type = await b.until(() => b.$("form.card select"), "the form");
    b.fill(type, "matching");
    await b.until(() => b.$(".pair-row"), "pair fields");
    b.fill(b.$("form.card textarea"), "Match them.");
    const pairs = b.$$("form.card .pair-row");
    [
      ["Spill", "Mop"],
      ["Exit", "Clear"],
      ["Injury", "Help"],
    ].forEach(([l, r], i) => {
      const [left, right] = pairs[i].querySelectorAll("input");
      b.fill(left, l);
      b.fill(right, r);
    });
    await b.press("Add question");
    await b.until(() => /Spill → Mop/.test(b.text()), "the matching question to be listed");

    await b.press("Publish");
    await b.until(() => b.byText("button", "Unpublish"), "the course to publish");
    await b.settled();
    const detail = await (await globalThis.fetch(`/api/admin/courses/${id}`)).json();
    assert.deepEqual(
      [detail.status, detail.lessons.length, detail.questions.map(q => q.type)],
      ["published", 1, ["mcq", "matching"]],
    );
  });
});

test("browser: every tab of the course editor loads without errors or stray text", async () => {
  const s = await start();
  const { id } = await quizCourse(s);
  await withBrowser(s, async b => {
    await b.signIn("author@example.com", PW);
    for (const tab of ["lessons", "questions", "people", "results", "certificates", "settings"]) {
      await b.show(manageCourseView, { user: user("author") }, [String(id), tab]);
      await b.until(() => b.$(".tabs"), `the ${tab} tab`);
      await b.settled();
      assert.ok(!b.$(".notice.error"), `${tab}: ${b.text()}`);
    }
  });
});

test("browser: enrolling people reports who was not found", async () => {
  const s = await start();
  const { id } = await publishedCourse(s);
  await withBrowser(s, async b => {
    await b.signIn("author@example.com", PW);
    await b.show(manageCourseView, { user: user("author") }, [String(id), "people"]);
    await b.until(() => b.$("textarea"), "the people tab");
    b.fill(b.$("textarea"), "learner@example.com\nnobody@example.com");
    await b.press("Enrol");
    await b.until(() => /Enrolled 1/.test(b.text()), "the report");
    assert.match(b.text(), /No active account for: nobody@example\.com/);
    assert.ok(b.byText("th", "learner@example.com"));
  });
});

test("browser: admin user management shows a new user's temporary password once, and refuses non-admins", async () => {
  const s = await start();
  await withBrowser(s, async b => {
    await b.signIn("author@example.com", PW);
    await b.show(usersView, { user: user("author") });
    assert.match(b.text(), /Only administrators can manage users/);

    await b.signIn("admin@example.com", PW);
    await b.show(usersView, { user: user("admin") });
    await b.until(() => b.$("form input[type=email]"), "the users page");
    b.fill(b.$("form input[type=email]"), "new.hire@example.com");
    await b.press("Create user");
    await b.until(() => b.$(".notice.warn code"), "the temporary password");
    assert.ok(b.$(".notice.warn code").textContent.length >= 10);
    assert.match(b.text(), /shown once/);
    assert.ok(b.byText("th", "new.hire@example.com"), "the new user is listed");

    // The last admin cannot be demoted: the page shows the server's reason and puts the choice back.
    const select = b.$('select[aria-label="Role for admin@example.com"]');
    select.value = "learner";
    select.dispatchEvent(new b.window.Event("change"));
    await b.until(() => /at least one active admin/.test(b.text()), "the refusal");
    assert.equal(select.value, "admin");
  });
});

test("browser: the appearance page blocks unreadable colours and saves readable ones", async () => {
  const s = await start();
  await withBrowser(s, async b => {
    await b.signIn("admin@example.com", PW);
    let reloaded = 0;
    await b.show(themeView, { user: user("admin"), reloadTheme: async () => reloaded++ });
    await b.until(() => b.byText("button", "Dark"), "the presets");
    await b.press("Dark");
    assert.match(b.text(), /Text on the page background: [\d.]+:1 \(good\)/);
    const save = b.byText("button", "Save appearance");
    assert.equal(save.disabled, false);

    const text = b.$('input[aria-label="Text as a hex code"]');
    b.fill(text, "#14171e"); // almost the same as the dark background
    assert.equal(save.disabled, true);
    assert.match(b.text(), /needs 4\.5:1 or more/);

    b.fill(text, "#e8ebf1");
    assert.equal(save.disabled, false);
    save.click();
    await b.until(() => /Saved\./.test(b.text()), "the save message");
    assert.equal(reloaded, 1);
    const saved = await (await globalThis.fetch("/api/theme")).json();
    assert.equal(saved.colours.background, "#14171d");
  });
});

test("browser: the audit page lists what happened, in words, and is for admins only", async () => {
  const s = await start();
  const { author } = await quizCourse(s);
  await author("/api/admin/courses", { method: "POST", body: { title: "Audited course" } });
  await withBrowser(s, async b => {
    await b.signIn("author@example.com", PW);
    await b.show(auditView, { user: user("author") });
    assert.match(b.text(), /Only administrators/);

    await b.signIn("admin@example.com", PW);
    await b.show(auditView, { user: user("admin") });
    await b.until(() => b.$$("tbody tr").length > 0, "audit rows");
    assert.ok(b.byText("th", "Created a course"));
    assert.match(b.text(), /Audited course/);
    assert.match(b.text(), /author@example\.com/);
    await b.settled();
  });
});

test("browser: a signed-out visitor is sent to sign in, and a temporary password blocks every page until it is replaced", async () => {
  const s = await start();
  const admin = await s.as("admin");
  const made = (await admin("/api/admin/users", { method: "POST", body: { email: "fresh@example.com" } }))
    .body;
  await withBrowser(s, async b => {
    await b.show(coursesView, { user: user("learner") }).catch(() => {}); // nobody is signed in
    assert.ok(b.events.includes("signed-out"));

    const me = await b.signIn("fresh@example.com", made.temporaryPassword);
    assert.equal(me.mustChangePassword, true);
    await b.show(coursesView, { user: user("learner") }).catch(() => {});
    assert.ok(b.events.includes("must-change-password"));
  });
});
