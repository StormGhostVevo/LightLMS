# Changelog

Notable changes, newest first. Dates are DD/MM/YYYY. Versions follow semantic versioning.

## Unreleased

## 0.3.0 (20/10/2026)

Launch readiness. Nothing new for learners; a good deal for whoever runs the site.

### Added
- **Backups.** Automatic, compressed, opened and checked before they are kept, with retention. A command line and an admin
  page to make, list, verify, download and restore them. A full restore drill is automated in the tests.
- **Safer migrations.** Each applied migration records a checksum; the server refuses to start if one was edited, is
  missing, is newer than the code, or is out of order. A backup is taken before any migration runs on a database with data.
- **Structured logging.** JSON lines with a request id (returned as `X-Request-Id`); bodies, cookies, queries, headers and
  IP addresses are never logged, and secrets are redacted. An unexpected error shows the person only a reference.
- **Privacy tools.** Export everything held about a person, and erase a person (admin page and command line). Erasing
  scrubs the audit log; certificates stay valid under "Name removed".
- **Security hardening.** A strict content security policy with no inline scripts or styles; an `Origin` check on changes;
  a per-account sign-in limit alongside the per-address one; refusal of very common passwords; a ceiling on API requests;
  `no-store` on API answers; a plain "Not found". See [docs/security-review.md](docs/security-review.md).
- **Accessibility checks** on every screen (axe-core), label-in-name checks, colour contrast of the palettes, and a test of
  the whole app with its real page. See [docs/accessibility.md](docs/accessibility.md).
- A `Dockerfile` and entrypoint, `.dockerignore`, graceful shutdown on SIGTERM, a lock that stops a restore while the
  server runs, and a deployment guide: [docs/deploy.md](docs/deploy.md).
- Dependabot configuration.

### Fixed
- Accessibility problems found by the new checks: a skipped heading level, empty table headers, two top-level headings
  on the Account page, and editor toolbar buttons whose spoken names didn't match their visible text.
- Messages shown after rebuilding a page (after erasing someone) went into the discarded copy.

### Changed
- Certificate pages load their styles from `/css/certificate.css`, not inline.
- 142 tests (from 90).

### Not done
- The Docker image has not been built and no hosting platform has been tried. The CI workflow has not run on GitHub.
- Two-factor sign-in, single sign-on, email, and per-course permissions.

## 0.2.0 (20/10/2026)

Foundations: no new learner features, but much safer and easier to change.

### Fixed
- Behind a proxy, every visitor looked like one address, so the sign-in rate limit would have locked everyone out
  together. The server now trusts a configured number of proxies (`TRUST_PROXY`, default 1 in production).
- Expired sessions were never removed. They are now swept at start-up and hourly.
- Pages could show the text "null" where an optional element was missing, and a name clash could silently disable a
  page's button. Both are fixed and now caught by tests and lint.

### Added
- Capability-based permissions. Every `/api/admin` route must be listed with the capability it needs; unlisted routes
  are refused.
- Audit log of important changes (users, courses, enrolment, certificates, appearance, AI use), with an admin page.
  Passwords and IP addresses are never recorded.
- In-process events, so features can react to changes without the code that makes them knowing about it.
- `/health` now reports the version and database schema, and returns 503 if the database is unreachable.
- Start-up configuration is validated, with a clear message for a mistake.
- Prettier, ESLint, TypeScript checking over JSDoc, and a CI workflow.
- Browser tests that run the real pages against a real server.
- `ARCHITECTURE.md` and `CONTRIBUTING.md`.

### Changed
- Question types are a registry with one file per type.
- Course, enrolment, question review and AI authoring rules moved into services; route files are thin.
- Tests split by area, with shared typed helpers (90 tests).

## 0.1.0 (20/10/2026)

First complete build: sign-in and roles; courses, lessons and pictures; six question types with AI drafting and quiz
generation; enrolment; quiz attempts and gradebook; completion tracking; certificates with public verification;
appearance settings; learner, author and admin interfaces.
