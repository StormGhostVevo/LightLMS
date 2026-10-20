# lightlms

A lightweight, AI-integrated learning platform. Courses, lessons and quizzes, with AI that drafts courses from source
material and generates quiz questions, always reviewed by a person before learners see them.

Built as: Node 22+ (Express), SQLite (better-sqlite3), plain JavaScript, no build step. One process, one database file.

Moodle's features are rebuilt from scratch (clean-room, no Moodle code). See [docs/moodle-feature-map.md](docs/moodle-feature-map.md).

## Run

    npm install
    cp .env.example .env
    npm run dev       # http://localhost:3000, AI_PROVIDER=stub by default (no external calls)
    npm test

Set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` to use the real AI. Pasted text is then sent to Anthropic, so only
use material you are cleared to share.

## Accounts and roles

Email and password sign-in (scrypt hashes, server-side sessions in an httpOnly SameSite=Lax cookie, 7 days). There is
no public sign-up. Roles: **admin** (everything, manages users), **author** (builds courses and reviews questions),
**learner** (takes published courses).

Make the first admin, then sign in and create everyone else through the API:

    npm run create-user -- you@example.com admin     # prints a temporary password once

Admins create users and reset passwords; the temporary password is shown once and the user is expected to change it.
Deactivating a user or changing their role ends their sessions. The last active admin can't be demoted or deactivated.
Writes to `/api/*` must be sent as `application/json` (part of the CSRF protection).

## API

- `POST /api/auth/login` `{ email, password }`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/password` `{ current, next }`
- `GET|POST /api/admin/users`, `PATCH /api/admin/users/:id` `{ role, active, name, resetPassword }` (admin only)

Enrolment: a published course is only visible to people enrolled in it (authors and admins can preview any published
course but can't take its quiz unless enrolled). A course is `manual` (staff enrol people) or `open` (anyone signed in
can enrol themselves).

- Learner: `GET /api/courses` (mine), `GET /api/courses/available` (open courses I haven't joined), `POST /api/courses/:id/enrol`
- Staff: `PATCH /api/admin/courses/:id` `{ title, description, enrolment }`, `GET|POST /api/admin/courses/:id/enrolments`
  (`{ emails: [...] }`, reports who was enrolled, already enrolled or not found), `DELETE /api/admin/courses/:id/enrolments/:userId`

Quizzes: an enrolled learner submits answers, the server marks them and stores the attempt. Per course, staff set a
`passMark` (0 to 100, default 70), `maxAttempts` (1 to 50, or null for unlimited) and `showAnswers` (`never`,
`after_pass` (default) or `always`), which controls when the correct options and explanations appear. Unanswered or
invalid answers count as wrong. Each attempt keeps a snapshot of the questions as the learner saw them, so editing a
question later never rewrites history.

- Learner: `POST /api/courses/:id/quiz`, `GET /api/courses/:id/attempts` (mine), `GET /api/attempts/:id`, `GET /api/grades` (my best score per course)
- Staff: `PATCH /api/admin/courses/:id` also takes `passMark`, `maxAttempts`, `showAnswers`
- Gradebook (staff): `GET /api/admin/courses/:id/gradebook` (per learner, summary, and questions ranked by how often they're missed),
  `GET /api/admin/courses/:id/gradebook.csv`, `GET /api/admin/courses/:id/users/:userId/attempts`

Completion: each course has a `completion` rule, `lessons` (every lesson marked done), `quiz` (quiz passed) or `both`
(the default; the quiz part is ignored if the course has no approved questions). Learners mark lessons done
themselves. The course is recorded as complete the first time the rule is met, and that is never taken back (adding a
lesson later or unticking one doesn't undo it). Changing the rule completes anyone who now qualifies. A course with
nothing to require never completes.

- Learner: `GET /api/courses/:id/progress`, `POST|DELETE /api/courses/:id/lessons/:lessonId/complete`; `GET /api/courses` now includes `percent` and `completed`
- Staff: `PATCH /api/admin/courses/:id` takes `completion`; the gradebook shows lessons done and completion per learner

Certificates: when someone completes a course, a certificate is issued automatically (switch off per course with
`certificate: false`). Each has its own unguessable code (`LL-XXXXX-XXXXX`), so two people finishing the same course on
the same day get different IDs. The name and course title are copied in when it is issued and the certificate survives
the course being deleted. Completions from before certificates were switched on are issued the next time someone looks.
The printable page is `/certificate/:code` (use the browser's Print or Save as PDF). **It and `/api/verify/:code` are
public**: anyone with the code sees the holder's name, course and date, which is what verification means. Both are rate-limited.
Set `ORG_NAME` and `TIMEZONE` in `.env` for what the page shows.

- Learner: `GET /api/certificates`, `GET /api/courses/:id/certificate`, `PATCH /api/auth/me` `{ name }` (the name printed on certificates issued from then on)
- Public: `GET /api/verify/:code`, `GET /certificate/:code`
- Staff: `GET /api/admin/courses/:id/certificates`, `PATCH /api/admin/certificates/:id` `{ recipientName, revoked, reason }`
  (correct a name, or revoke / restore; a revoked certificate shows as invalid), `PATCH /api/admin/courses/:id` takes `certificate`

Authoring (authors and admins). Edits to a published course are live immediately; there is no separate draft of a published course.

- Courses: `POST /api/admin/courses` `{ title, description }` (blank course), `POST .../:id/unpublish`, `DELETE .../:id` (drafts only, since it removes attempts and completions; unpublish first)
- Lessons: `POST /api/admin/courses/:id/lessons` `{ title, body }` (HTML is sanitised), `PATCH|DELETE /api/admin/lessons/:id`,
  `PUT /api/admin/courses/:id/lessons/order` `{ order: [ids] }`. A published course can't lose its last lesson.
- Questions: `POST /api/admin/courses/:id/questions` `{ prompt, options, answer, explanation, status }` (approved by default, since a person wrote it),
  `PATCH|DELETE /api/admin/questions/:id`, `PUT /api/admin/courses/:id/questions/order`
- Changing lessons or questions re-checks completion, so someone isn't stuck behind a requirement that no longer exists.
  Completions already earned and attempts already taken are never altered; an attempt keeps the question text it was taken with.
- Limits: 100 lessons and 200 questions per course. The gradebook's "most missed questions" groups by question id, so
  after you substantially rewrite a question its old attempts still count towards it.

Authoring routes need the author or admin role:

- `POST /api/admin/ai/draft-course` `{ text }` creates a draft course with lessons and draft questions
- `POST /api/admin/courses/:id/quiz/generate` `{ count }` adds draft questions from the lessons
- `PATCH /api/admin/questions/:id` edit or approve (`status: "approved"`); `DELETE` removes
- `POST /api/admin/courses/:id/publish`
- Enrolled users: `GET /api/courses/:id` for a published course; only approved questions, no answers
- `POST /api/courses/:id/quiz` `{ answers: { questionId: optionIndex } }` marked on the server
