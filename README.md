# lightlms

A lightweight, AI-integrated learning platform. Courses, lessons and quizzes, with AI that drafts courses from source
material and generates quiz questions, always reviewed by a person before learners see them.

Built as: Node 22+ (Express), SQLite (better-sqlite3), plain JavaScript, no build step. One process, one database file.

Moodle's features are rebuilt from scratch (clean-room, no Moodle code). See [docs/moodle-feature-map.md](docs/moodle-feature-map.md).
Running it (settings, backups, restore, updates): [docs/deploy.md](docs/deploy.md). Security: [docs/security-review.md](docs/security-review.md). Accessibility: [docs/accessibility.md](docs/accessibility.md).
How it is built and how to change it: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Working agreement: [CONTRIBUTING.md](CONTRIBUTING.md). Changes: [CHANGELOG.md](CHANGELOG.md).
For an honest look at where the project stands, its maintainability compared with Moodle, known problems and what to build next, see [docs/review-and-roadmap.md](docs/review-and-roadmap.md).

## Learner interface

A single-page app in plain JavaScript (no framework, no build step) in `public/`, served by the same process. Pages: sign-in,
forced change of a temporary password, my courses (with progress and open courses to join), a course (lessons with
mark-as-done, the quiz with attempts and review, progress, certificate link), grades, and account (name, certificates,
password). Everything the server sends is rendered as text; the only HTML shown is lesson content, which the server has
already sanitised. It works with the strict content security policy (no inline scripts or styles on the page itself),
keyboard navigation, light and dark mode, and phone widths.

## Author and admin interface

Authors and admins get a **Manage** link. **Manage courses** lists every course and lets you create a blank one or draft
one with AI from pasted material (the page says whether text is sent to an external AI service). Each course has tabs:

- **Lessons**: add, edit (a small rich-text editor: bold, italic, headings, lists, links, pasted as plain text), reorder, delete.
- **Questions**: add by hand, generate more with AI, edit, reorder, approve or unapprove. AI questions start as drafts and
  learners never see a draft; "Approve all" asks you to confirm you've read them.
- **People**: enrol by pasting email addresses (unknown addresses are reported), remove people.
- **Results**: enrolled, tried, passed, completed, average score, per-person answers, questions most often missed, CSV download.
- **Certificates**: correct the printed name, revoke or restore.
- **Settings**: enrolment, completion rule, pass mark, attempts, when answers show, certificates, delete a draft.

Publish and Unpublish are at the top of every course. Admins also get **Manage users**: create users (the temporary password
is shown once), change roles, deactivate or reactivate, reset passwords. Everything here is enforced by the server as
well, so hiding a button is never the only protection.

### Appearance (admins)

**Manage, then Appearance** changes the whole site's look: a site name (top bar and sign-in page), a font, the text size and
the colours. Colours come in three sets chosen together: **page** (background, cards, text, links), **buttons** (button and
button text) and **top bar** (bar and its text), because setting one without the colour that sits on it can make the site
unreadable. Each set is optional; anything you don't set follows the device's light or dark mode. The server refuses any
pair of colours below a 4.5:1 contrast ratio (WCAG AA), and the page shows the ratios live next to a preview. There are
presets (Default, Dark, High contrast, Warm, Ocean). Fonts are limited to ones already installed on people's devices, so
nothing loads from outside the site. The look is delivered as `/theme.css`, built only from validated values.

- `GET /api/theme` (public), `GET /api/theme/options`, `GET /theme.css`; `PUT|DELETE /api/admin/theme` (admin only)

### Cover images

Each course can have a cover image (Settings tab), shown on its card and at the top of the course. PNG, JPEG, WebP or GIF up
to 2 MB; large photos are shrunk in the browser before upload. The server decides what a file is from its bytes (not what the
browser claims), and SVG is refused because it can carry scripts. Alt text is required unless you mark the image decorative.
Images are stored in the database, so a backup of the one file includes them. Image addresses (`/media/<random key>`) are public
but unguessable, so don't use a cover image for anything sensitive. Replacing or removing an image deletes the old one.

- `PUT|DELETE /api/admin/courses/:id/image` `{ data: base64, alt, decorative }`, `GET /media/:key`

### Question types

Six types, each marked all or nothing (a question is right only if the whole answer is right). Unanswered counts as wrong.

| Type | The learner | Counts as correct |
|---|---|---|
| Multiple choice | picks one option | the right option |
| True or false | picks True or False | the right one |
| Select all that apply | ticks any number of options | exactly the right set (not one missing or extra) |
| Short answer | types a word or phrase | matches any accepted answer; capitals and extra spaces are ignored |
| Number | types a number | within the tolerance you set (0 for exact); `1,000` is read as one thousand |
| Matching | matches each item to its pair from a shuffled list | every pair right |

Authors choose the type when adding or editing a question, and can change a question's type later (the new type's fields are
required). **Generate with AI** can write a mix of types; everything it writes is a draft until approved, like before.
Attempts keep a snapshot of each question and its answer key, so editing or deleting a question later never changes an old
result, and attempts taken before types existed still display. Answers are revealed according to the course's rule for every
type. Learners are never sent the answer key; matching choices are shuffled in a fixed order that doesn't give the pairing away.

- Learner answers: `POST /api/courses/:id/quiz` `{ answers: { questionId: answer } }` where the answer is an option number
  (choice, true/false: 0 is True), a list of option numbers (select all), text (short answer), a number or text (number),
  or a list of chosen matches in item order (matching).
- Staff: `POST /api/admin/courses/:id/questions` and `PATCH /api/admin/questions/:id` take `type` plus that type's fields
  (`options`/`answer`, `answers`, `accepted`, `value`/`tolerance`, `pairs`); `POST .../quiz/generate` takes `types`.

### Pictures in lessons

The lesson editor has a **Picture** button. Pick an image, describe it (the description becomes its alt text; leave it blank only
for pure decoration, which asks you to confirm), and it is inserted where the cursor was. Large photos are shrunk before upload.
In lesson HTML an image is only kept if it points at this site's own `/media/<key>` address, so a lesson can never load
something from elsewhere, and any other attribute is dropped. Limits: 2 MB each, 60 pictures and 25 MB per course. A picture that
no lesson uses any more is deleted once it is an hour old (never sooner, so one uploaded while you're still writing isn't lost).
Cover images and lesson pictures are tracked separately, so replacing a cover never touches lesson pictures.

- `POST /api/admin/courses/:id/images` `{ data: base64 }` returns `{ url }`

Try it with sample data (development only; it refuses to run in production):

    npm run seed-demo   # admin@demo.test, author@demo.test, learner@demo.test, password demo-password-1
    npm run dev         # http://localhost:3000

## Run

    npm install
    cp .env.example .env
    npm run dev       # http://localhost:3000, AI_PROVIDER=stub by default (no external calls)
    npm test          # the tests
    npm run check     # formatting, lint, types and tests: the same as CI

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
