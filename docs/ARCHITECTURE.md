# Architecture

How lightlms is put together, and where to make a change. Read this before your first change.

## The shape

One Node process, one SQLite file, no build step. The server is Express. The browser code is plain JavaScript modules
served as they are. Everything a person sees comes from the API; nothing in `public/` contains course content.

```
server/
  index.js            starts the server (reads config, opens the database, sweeps old sessions)
  app.js              wiring only: builds services, mounts routes, sets up middleware
  config.js           every setting, validated once at start-up
  db.js               opens SQLite and applies numbered migrations
  http.js             now(), bad(), HttpError, the one error handler
  permissions.js      who may do what (capabilities), and the admin route table
  events.js, audit.js a small event bus, and the observer that writes the audit log
  logger.js           JSON logging with request ids and secret redaction
  backup.js, backup-cli.js, privacy-cli.js   backups and restore; export and erase of a person
  services/           the rules: courses, enrolment, question review, AI authoring, privacy
  routes/             thin route files that call services: admin-courses.js, admin-backups.js, learner.js
  question-types/     one file per question type, behind a registry (index.js)
  auth.js             sign-in, sessions, users
  quiz.js, completion.js, certificates.js, editing.js, images.js, theme.js
                      feature modules: their routes and their rules together
  migrations/         numbered SQL files, never edited once applied
  test/               tests (see "Tests")
public/
  index.html, css/    the single page and its styles
  js/                 app.js (router and shell), api.js, dom.js, editor.js, image.js, views/
```

## How a request travels

1. `helmet` adds security headers. JSON bodies are parsed (small limit; a bigger one for image uploads only).
2. `/api` requests must be JSON for anything that changes data (this, with `SameSite=Lax`, is the CSRF protection).
3. `sessionMiddleware` finds the person from the session cookie (`req.user`), or leaves it null.
4. Someone on a temporary password is refused everywhere except the sign-in and password routes.
5. The route runs. Staff routes first pass `adminGuard`, which looks the route up in `ADMIN_ROUTES`.
6. A route calls a **service**. The service checks the rules and throws `HttpError` with a message a person can read.
7. `errorHandler` turns the error into `{ "error": "..." }` with the right status. Anything unexpected becomes a
   generic 500 and is logged, never shown.

## The ideas that keep it maintainable

**Routes are thin; services hold the rules.** A route reads the request, calls a service, emits an event and sends the
result. Rules such as "a pass mark is a whole number from 0 to 100" live in a service, where they can be tested without
HTTP. Not every area has been moved yet: `quiz.js`, `certificates.js`, `theme.js`, `images.js` and `auth.js` still keep
routes and rules together. When you change one of them substantially, move its rules into a service.

**Permissions are capabilities.** Routes never ask "is this person an admin?". They ask `can(user, "course:author")`.
`permissions.js` says which roles hold which capabilities, and `ADMIN_ROUTES` says which capability each admin route
needs. **A route that is not listed is refused**, and a test fails if a registered route is missing from the table.
Learners hold no capabilities: they sign in, and see a course only if enrolled.

**Things announce what happened.** Code that changes something emits an event (`events.emit("course.published", ...)`).
It does not know who is listening. Today the audit log is the only listener. Email or analytics would be added as
another observer. A failing observer never breaks the request.

**Question types are a registry.** Each type is one file that provides the same set of functions (see
`question-types/shared.js`). Validation, marking, what staff see, what a learner sees and the result text are all in
that file.

**Answers never leak.** A learner's view of a question is built by the type's `forLearner`, which has no answer key.
Attempts store a snapshot of each question and its key, so editing a question later never rewrites history, and the
server decides when to reveal answers.

**All text from users is untrusted.** Plain text goes through `plain()`. Lesson HTML goes through `cleanBody()`, which
allows a short list of tags and only this site's own `/media/` images. The browser builds pages with `h()` (text is
always text), never by pasting strings into HTML. Lesson HTML is the one exception, and it is sanitised first.

**Defaults are safe.** Unlisted admin routes are refused. A missing setting has a safe default. Production turns the AI
off unless it is switched on. Passwords and session ids are stored only as hashes.

## How to...

**Add an admin route.** Write it on the `admin` router in the right route file. Add its path to `ADMIN_ROUTES` in
`permissions.js` with the capability it needs. Emit an event if it changes something worth auditing. Add a test.

**Add a capability.** Add it to `GRANTS` in `permissions.js`, then to the matrix test in `test/permissions.test.js`
(the test fails until you do, on purpose).

**Add an event.** `events.emit("thing.happened", { actor: req.user, target: target("thing", id, label), detail: {...} })`.
Never put secrets in `detail`. Add its words to `WORDS` in `public/js/views/manage/audit.js`.

**Add a question type.** Create `question-types/your-type.js` exporting a `QuestionType`. List it in
`question-types/index.js`. The contract test in `test/question-types.test.js` checks it. Then add its two screens: the
author's fields in `public/js/views/manage/questions.js` and the learner's control in `public/js/views/course.js`.
Add a migration only if the database's list of allowed types has to change (it does: see `009_question_types.sql`).

**Change the database.** Add the next numbered file in `server/migrations/`. **Never edit one that has been applied
anywhere.** Migrations only move forward. Write them so existing data keeps working, and say in the file why.

**Add a setting.** Add it to the schema in `config.js` with a default, document it in `.env.example`, and add a case to
the config test.

## Tests

`npm test` runs everything in `server/test/`. They are organised by area, not by file.

- **API tests** start a real server on a free port with an in-memory database and make real HTTP calls
  (`helpers.js`). Most tests are these.
- **Service and unit tests** (`services.test.js`, `question-types.test.js`, `text.test.js`) call code directly with no
  server. Prefer these for rules.
- **Browser tests** (`browser.test.js`) run the real pages in jsdom against a real server (`browser-helpers.js`). They
  check behaviour and content, not looks. Every page is also checked for leaked `null` or `undefined` text.
- **Permission tests** (`permissions.test.js`) check the whole role by capability matrix, that every admin route is
  listed, and that learners and signed-out visitors are refused on every admin route.

`npm run check` runs formatting, lint, type checks and the tests, the same as CI.

## Running it

Logging, backups, restore, migrations, deployment and monitoring are in [deploy.md](deploy.md). Security is in
[security-review.md](security-review.md) and accessibility in [accessibility.md](accessibility.md).

Two rules worth knowing here: **a migration that has been applied is fixed** (the server checks a checksum and refuses to
start if it changed), and **there is exactly one server process per database** (SQLite).

## What is not here yet

Email, two-factor sign-in or single sign-on, per-course permissions, and content versions with history. The Docker image
and a real hosting platform have not been tried. See [review-and-roadmap.md](review-and-roadmap.md).
