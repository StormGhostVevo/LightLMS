# Changelog

Notable changes, newest first. Dates are DD/MM/YYYY. Versions follow semantic versioning.

## Unreleased

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
