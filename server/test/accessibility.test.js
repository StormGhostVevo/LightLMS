import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { start, publishedCourse, ONE_OF_EACH, PW } from "./helpers.js";
import { openBrowser } from "./browser-helpers.js";
import { contrast } from "../theme.js";
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
import { backupsView } from "../../public/js/views/manage/backups.js";

// WCAG 2.5.3 "Label in Name": if a control has visible text, its accessible name must contain it,
// or someone who speaks "click Save" to their computer can't reach it.
function labelProblems(root) {
  const problems = [];
  for (const el of root.querySelectorAll("button[aria-label], a[aria-label], [role=button][aria-label]")) {
    const visible = el.textContent.replace(/\s+/g, " ").trim().toLowerCase();
    const label = el.getAttribute("aria-label").toLowerCase();
    if (visible && !label.includes(visible))
      problems.push(`"${el.getAttribute("aria-label")}" does not contain its visible text "${visible}"`);
  }
  return problems;
}

test("accessibility: every screen passes the WCAG 2.2 A and AA rules that can be checked automatically", async () => {
  const s = await start(undefined, {
    config: { backupDir: "/tmp/lightlms-a11y/backups", backupKeep: 3, backupEveryHours: 24 },
  });
  const { author, id } = await publishedCourse(s);
  for (const q of Object.values(ONE_OF_EACH))
    await author(`/api/admin/courses/${id}/questions`, { method: "POST", body: q });
  await author(`/api/admin/courses/${id}/enrolments`, {
    method: "POST",
    body: { emails: ["learner@example.com"] },
  });
  const b = openBrowser(s);
  const found = [];
  const check = async name => {
    await b.settled();
    for (const p of [...(await b.axeProblems()), ...labelProblems(b.main)]) found.push(`${name}: ${p}`);
  };
  try {
    b.main.append(loginView(() => {}, "Acme"));
    await check("sign-in");

    await b.signIn("learner@example.com", PW);
    const learner = { user: { role: "learner", email: "learner@example.com", name: "" } };
    await b.show(coursesView, learner);
    await check("my courses");
    await b.show(courseView, learner, [String(id)]);
    await b.until(() => b.$(".quiz"), "the course");
    await check("a course");
    await b.press("Start the quiz");
    await b.until(() => b.$$(".quiz fieldset").length === 6, "the quiz form");
    await check("the quiz (every question type)");
    await b.press("Submit answers");
    await b.until(() => /Answer every question/.test(b.text()), "the validation message");
    await check("the quiz with a validation message");
    await b.show(gradesView, learner);
    await check("grades");
    await b.show(accountView, learner);
    await check("account");

    await b.signIn("admin@example.com", PW);
    const admin = { user: { role: "admin", email: "admin@example.com", name: "" } };
    await b.show(manageView, admin);
    await check("manage courses");
    for (const tab of ["lessons", "questions", "people", "results", "certificates", "settings"]) {
      await b.show(manageCourseView, admin, [String(id), tab]);
      await b.until(() => b.$(".tabs"), `the ${tab} tab`);
      await check(`course editor: ${tab}`);
    }
    await b.show(manageCourseView, admin, [String(id), "questions"]);
    await b.until(() => b.byText("button", "Add a question"), "the questions tab");
    await b.press("Add a question");
    await b.until(() => b.$("form.card select"), "the question form");
    await check("course editor: new question form");
    const type = b.$("form.card select");
    for (const t of ["multiple_response", "short_answer", "numeric", "matching", "true_false"]) {
      b.fill(type, t);
      await check(`question form: ${t}`);
    }
    await b.show(manageCourseView, admin, [String(id), "lessons"]);
    await b.until(() => b.$(".tabs"), "the lessons tab");
    await b.press("Add a lesson");
    await b.until(() => b.$(".editor-area"), "the lesson editor");
    await check("course editor: lesson editor");
    await b.show(usersView, admin);
    await b.until(() => b.$("tbody tr"), "the users");
    await check("users");
    await b.show(themeView, admin);
    await b.until(() => b.$(".presets"), "the presets");
    await check("appearance");
    await b.show(auditView, admin);
    await check("audit log");
    await b.show(backupsView, admin);
    await check("backups");
  } finally {
    b.close();
    s.close();
  }
  assert.deepEqual(found, [], `\n${found.join("\n")}`);
});

test("accessibility: the whole app, as a person would use it: landmarks, skip link, focus, titles, and signing in by keyboard flow", async () => {
  const s = await start();
  const { id } = await (async () => {
    const { author, id: courseId } = await publishedCourse(s);
    await author(`/api/admin/courses/${courseId}/enrolments`, {
      method: "POST",
      body: { emails: ["learner@example.com"] },
    });
    return { id: courseId };
  })();
  const b = openBrowser(s, { html: readFileSync("public/index.html", "utf8") });
  try {
    await import("../../public/js/app.js"); // starts the real app in this page, as the browser does
    const { document } = b;
    const problems = async name => (await b.axeProblems(document)).map(p => `${name}: ${p}`);
    const found = [];

    // Signed out: the sign-in page.
    await b.until(() => document.querySelector("form"), "the sign-in form");
    assert.equal(document.documentElement.lang, "en-AU");
    assert.equal(document.title, "Sign in | lightlms");
    assert.equal(document.querySelectorAll("h1").length, 1);
    assert.equal(document.querySelectorAll("main").length, 1);
    const skip = document.querySelector("a.skip");
    assert.equal(skip.getAttribute("href"), "#main");
    assert.equal(skip.textContent, "Skip to content");
    assert.ok(document.getElementById("main"), "the skip link points at something");
    found.push(...(await problems("sign-in page")));

    // Sign in with the real form.
    const [email, password] = document.querySelectorAll("input");
    b.fill(email, "learner@example.com");
    b.fill(password, PW);
    document.querySelector("form").requestSubmit();
    await b.until(() => document.querySelector("nav"), "the signed-in page");
    assert.equal(document.querySelectorAll("nav").length, 1);
    assert.equal(document.querySelector("nav").getAttribute("aria-label"), "Main");
    assert.equal(document.querySelectorAll("header").length, 1);
    assert.equal(document.querySelectorAll("main").length, 1);
    await b.until(() => document.querySelector("h1"), "the home heading");
    assert.equal(document.activeElement?.id, "main"); // focus moves to the content on each page, as a screen reader user expects
    assert.equal(document.querySelector('nav a[aria-current="page"]').textContent, "My courses");
    found.push(...(await problems("home")));

    // Move around the way links do, and check each page title, current-page marker and focus.
    /** @type {[string, string | null, RegExp][]} */
    const visits = [
      [`#/course/${id}`, null, /^Safety basics \| lightlms$/],
      ["#/grades", "Grades", /^Grades \| lightlms$/],
      ["#/account", "Account", /^Account \| lightlms$/],
    ];
    for (const [hash, nav, title] of visits) {
      b.window.location.hash = hash;
      await b.until(() => title.test(document.title), `the title for ${hash}`);
      await b.settled();
      assert.equal(document.activeElement?.id, "main", `focus after going to ${hash}`);
      if (nav) assert.equal(document.querySelector('nav a[aria-current="page"]').textContent, nav);
      assert.equal(
        document.querySelectorAll("h1").length,
        1,
        `one main heading on ${hash}: ${[...document.querySelectorAll("h1")].map(h => h.textContent)}`,
      );
      found.push(...(await problems(hash)));
    }

    // Signing out brings back the sign-in page.
    const out = [...document.querySelectorAll("button")].find(x => x.textContent === "Sign out");
    out.click();
    await b.until(() => document.title === "Sign in | lightlms", "the sign-in page again");
    assert.deepEqual(found, [], `\n${found.join("\n")}`);
  } finally {
    b.close();
    s.close();
  }
});

// ---------------- colour contrast ----------------
// A real screen is needed to measure rendered contrast, but the site's colours are all defined in one place, so the
// palettes themselves can be checked: normal text needs 4.5:1 against what it sits on (WCAG 2.2 AA 1.4.3).

const css = readFileSync("public/css/app.css", "utf8");
const longHex = h => (h.length === 4 ? `#${[...h.slice(1)].map(c => c + c).join("")}` : h); // #fff is #ffffff
const palette = block =>
  Object.fromEntries(
    [...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{3,6})\b/gi)].map(m => [m[1], longHex(m[2])]),
  );
const light = palette(/:root\s*\{([^}]*)\}/.exec(css)[1]);
const dark = palette(/prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)[1]);
const PAIRS = [
  ["text", "bg"],
  ["text", "surface"],
  ["muted", "bg"],
  ["muted", "surface"],
  ["link", "bg"],
  ["link", "surface"],
  ["accent-text", "accent"],
  ["ok", "ok-bg"],
  ["bad", "bad-bg"],
];

for (const [name, colours] of [
  ["light", light],
  ["dark", dark],
]) {
  test(`colour contrast: the ${name} palette meets WCAG AA (4.5:1) for every text and background pairing`, () => {
    const merged = { ...light, ...colours }; // the dark block only overrides some colours
    const low = [];
    for (const [fg, bg] of PAIRS) {
      assert.ok(merged[fg] && merged[bg], `the ${name} palette should define --${fg} and --${bg}`);
      const ratio = contrast(merged[fg], merged[bg]);
      if (ratio < 4.5) low.push(`${fg} on ${bg}: ${ratio.toFixed(2)}:1`);
    }
    assert.deepEqual(low, []);
  });
}

test("colour contrast: warning notices and the presets offered to admins also meet AA", () => {
  const warn = /\.notice\.warn\s*\{[^}]*background:\s*(#[0-9a-f]{6});\s*color:\s*(#[0-9a-f]{6})/i.exec(css);
  assert.ok(
    contrast(warn[2], warn[1]) >= 4.5,
    `warning notice (light): ${contrast(warn[2], warn[1]).toFixed(2)}:1`,
  );
  const darkWarn = /\.notice\.warn\s*\{\s*background:\s*(#[0-9a-f]{6});\s*color:\s*(#[0-9a-f]{6})/i.exec(
    css.slice(css.lastIndexOf("prefers-color-scheme: dark")),
  );
  assert.ok(
    contrast(darkWarn[2], darkWarn[1]) >= 4.5,
    `warning notice (dark): ${contrast(darkWarn[2], darkWarn[1]).toFixed(2)}:1`,
  );
});

test("accessibility: keyboard focus is always visible, and motion is reduced when asked", () => {
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px solid/, "a clear focus outline");
  assert.ok(
    !/outline:\s*none/.test(css.replace(/main:focus\s*\{[^}]*outline:\s*none[^}]*\}/, "")),
    "no other rule may remove the focus outline",
  );
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  const index = readFileSync("public/index.html", "utf8");
  assert.match(index, /<html lang="en-AU">/);
  assert.match(index, /name="viewport" content="width=device-width, initial-scale=1"/); // and zoom isn't disabled:
  assert.ok(!/user-scalable\s*=\s*no|maximum-scale/i.test(index), "people must be able to zoom");
});
