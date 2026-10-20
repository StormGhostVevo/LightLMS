import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { hashPassword } from "./auth.js";

// Development only: a few accounts and a small course to click through. Fixed, well-known password,
// so it refuses to run in production. Safe to run twice (it skips anything that already exists).
if (process.env.NODE_ENV === "production") {
  console.error("seed-demo is for development only.");
  process.exit(1);
}

const PASSWORD = "demo-password-1";
const config = loadConfig();
const db = openDb(config.dbPath);
const now = new Date().toISOString();

const hash = await hashPassword(PASSWORD);
for (const [email, name, role] of [
  ["admin@demo.test", "Demo Admin", "admin"],
  ["author@demo.test", "Demo Author", "author"],
  ["learner@demo.test", "Demo Learner", "learner"],
])
  db.prepare(
    "INSERT OR IGNORE INTO users (email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(email, name, role, hash, now);

function course({ title, description, enrolment, lessons, questions }) {
  if (db.prepare("SELECT 1 FROM courses WHERE title = ?").get(title)) return null;
  const id = db
    .prepare(
      "INSERT INTO courses (title, description, status, enrolment, created_at, updated_at) VALUES (?, ?, 'published', ?, ?, ?)",
    )
    .run(title, description, enrolment, now, now).lastInsertRowid;
  lessons.forEach(([t, body], i) =>
    db
      .prepare("INSERT INTO lessons (course_id, position, title, body) VALUES (?, ?, ?, ?)")
      .run(id, i, t, body),
  );
  questions.forEach(([prompt, options, answer, explanation], i) =>
    db
      .prepare(
        "INSERT INTO questions (course_id, position, prompt, options, answer, explanation, source, status) VALUES (?, ?, ?, ?, ?, ?, 'manual', 'approved')",
      )
      .run(id, i, prompt, JSON.stringify(options), answer, explanation),
  );
  return id;
}

const safety = course({
  title: "Workplace safety basics",
  enrolment: "manual",
  description: "The essentials for staying safe at work.",
  lessons: [
    [
      "Why safety matters",
      "<p>Most incidents are preventable. A few small habits make the biggest difference.</p><ul><li>Look before you step</li><li>Keep walkways clear</li><li>Speak up early</li></ul>",
    ],
    [
      "Reporting hazards",
      "<p>If you see something unsafe, <strong>report it straight away</strong> to your supervisor. Don't wait for someone else to do it.</p>",
    ],
    [
      "If something goes wrong",
      "<p>Make the area safe, get help, then write down what happened while it is fresh.</p>",
    ],
  ],
  questions: [
    [
      "What should you do when you spot a hazard?",
      ["Report it straight away", "Wait and see", "Mention it next month"],
      0,
      "Early reports stop small problems becoming incidents.",
    ],
    [
      "Walkways should be...",
      ["Used for storage", "Kept clear", "Blocked at night"],
      1,
      "Clear walkways prevent trips and falls.",
    ],
    [
      "After an incident you should...",
      ["Make the area safe and get help", "Leave quickly", "Say nothing"],
      0,
      "Safety first, then record what happened.",
    ],
  ],
});
const open = course({
  title: "Getting started (open to everyone)",
  enrolment: "open",
  description: "A short intro anyone can join.",
  lessons: [["Welcome", "<p>Welcome aboard. This short course shows how the learning site works.</p>"]],
  questions: [
    [
      "Can you retake a quiz?",
      ["Yes, up to the attempt limit", "Never"],
      0,
      "Courses can allow several attempts.",
    ],
  ],
});
if (safety)
  db.prepare(
    "INSERT OR IGNORE INTO enrolments (course_id, user_id, enrolled_at) SELECT ?, id, ? FROM users WHERE email = 'learner@demo.test'",
  ).run(safety, now);

console.log(
  `Demo data ready. Sign in as admin@demo.test, author@demo.test or learner@demo.test with password: ${PASSWORD}`,
);
