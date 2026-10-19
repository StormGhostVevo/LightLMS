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

Authoring routes need the author or admin role:

- `POST /api/admin/ai/draft-course` `{ text }` creates a draft course with lessons and draft questions
- `POST /api/admin/courses/:id/quiz/generate` `{ count }` adds draft questions from the lessons
- `PATCH /api/admin/questions/:id` edit or approve (`status: "approved"`); `DELETE` removes
- `POST /api/admin/courses/:id/publish`
- Enrolled users: `GET /api/courses/:id` for a published course; only approved questions, no answers
- `POST /api/courses/:id/quiz` `{ answers: { questionId: optionIndex } }` marked on the server
