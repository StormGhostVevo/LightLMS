# Review and roadmap

Written 20/10/2026, after the first full build. It records what exists, how it compares with Moodle on maintainability,
the problems found when reading the code with fresh eyes, and what could be built next. Every number below was measured
on the repository on that date.

## 1. What exists

A learning platform in one Node process with one SQLite file and no build step.

| Area | What it does |
|---|---|
| People | Email and password sign-in, server-side sessions, roles (admin, author, learner), admin user management, forced password change |
| Content | Courses with lessons (rich text, pictures), cover images, draft and publish, reorder, delete, AI drafting from pasted material |
| Assessment | Six question types, AI quiz generation, human approval of AI questions, attempt limits, pass marks, answer-reveal rules, attempt history |
| Progress | Enrolment (manual or open), lesson ticks, completion rules, permanent completion records, certificates with public verification |
| Reporting | Gradebook, per-learner answers, most-missed questions, CSV export |
| Admin | Appearance (colours in readable groups, font, size, site name), people, certificates |

Size: about 93 KB of server code in 17 files, about 1,400 lines of browser code, 9 migrations, 7 runtime dependencies,
`npm audit` clean. 52 tests, all through the HTTP API, in one file.

## 2. Moodle's maintainability, and where we stand

Moodle is maintainable at its scale because of a handful of mechanisms, not because PHP is. Each one has a small-scale
equivalent that fits this project.

| Moodle mechanism | Status here | What to do |
|---|---|---|
| Capability-based permissions (roles are bundles of capabilities, checked in a context) | Weak. 35 inline role checks, three fixed roles. Any author can edit, delete and see results for every course | One `can(user, capability, course)` function. Gives per-course teachers and reviewers later |
| Versioned upgrade scripts | Okay. Numbered SQL migrations run on start | Add checksums so an edited applied migration is caught, a backup before migrating, and a "never edit applied migrations" rule |
| Plugin types with stable APIs (question types, activities, auth, enrolment) | Partial. Question types are centralised in one file but not a registry | Make question types, AI providers and completion rules registries, so a new one is one file. Skip a public plugin system |
| Events and observers | None. Nothing records who changed what | In-process event emitter. Observers for the audit log now, email and analytics later |
| Automated tests at several levels (unit, integration, browser) | Weak. Only API tests, one 995 line file, no browser tests | Split by domain, add unit tests for pure logic, add a few browser tests for key flows |
| Coding standard enforced by tooling | None. 89 server and 111 browser lines are over 140 characters (longest 273) | Formatter and linter in CI |
| Audit and logging | None. Only `console.error` | Audit log table, structured logs with a request id |
| Backup and restore, privacy tools | None | SQLite online backup, tested restore, export and erase for a person |
| Developer documentation, release process | README and feature map only | ARCHITECTURE, CONTRIBUTING, API reference, CHANGELOG, versioning |
| Security process | Strict content security policy, sanitised HTML, server-enforced rules. No formal review | Written security review, dependency checks in CI |
| Community, long term support | None. This is a real gap and will stay one | Mitigate with small size, few dependencies, good docs |

The honest summary: Moodle-style maintainability practices are achievable here. Moodle's ecosystem (thousands of plugins,
a decade of fixes, a security team) is not, and the project should not promise it.

## 3. Problems found when reading the code

Ordered by how much they matter.

1. **No `trust proxy` setting.** Behind Railway or any proxy, every visitor looks like one IP address, so the login rate
   limit (10 attempts per 10 minutes) would lock everyone out together. Must be fixed before any deployment.
2. **Expired sessions are never purged.** A row is only removed if that exact session is used again, so the table grows forever.
3. **Authors can touch every course.** Fine for a small internal team, wrong for anything larger or multi-tenant.
4. **No audit trail.** Role changes, revoking certificates, publishing and deleting leave no record.
5. **No backup, restore, Dockerfile, CI or deploy path.** Images now live in the database too, so the one file matters more.
6. **Business logic and SQL live inside route handlers.** `bad()` and `now()` are redefined in nine files. A schema change
   means hunting through many files.
7. **Performance ceilings.** Changing a question re-checks completion for every enrolled person. The gradebook parses every
   attempt's JSON on each request. SQLite calls block the event loop. Comfortable for hundreds of users, not for tens of thousands.
8. **Published edits are live immediately.** No draft copy of a published course, no history, no undo.
9. **Unverified against reality.** The real Anthropic API has never been called. Nothing has been through an accessibility
   audit or a security review. Most browser checks were by reading the page rather than looking at it.
10. **No password reset or email of any kind.** Admins reset passwords by hand.

## 4. What is still possible

Sizes are relative: S is hours, M is a day or two, L is several days.

**Content**
- Sections inside a course, prerequisites and learning paths (M)
- Content versions with a draft copy of a published course, history and restore (L)
- Course duplicate, and export or import as one file (M)
- Categories, tags and search (M)
- Video embeds from an allowlist, file attachments (M)
- Scheduled publishing (S)

**Assessment**
- Partial credit, quiz time limit, shuffle (S each)
- Question bank with categories, reuse and random draw (L)
- Free-text and essay questions with manual marking (M)
- Assignments with file upload and rubric (L)

**People**
- Bulk CSV import (S)
- Single sign-on with Google or Microsoft (M)
- Password reset by email (S once email exists)
- Groups and cohorts, enrol by group (M)
- Per-course roles such as teacher and reviewer (M, depends on the capability work)
- Deactivate, export and erase a person for privacy (M)

**Communication**
- Email: enrolment, reminders, completion (M)
- Due dates, calendar feed, overdue reminders (M)
- Announcements (S). Forums and messaging: recommend skipping

**Reporting**
- Admin dashboard, completion by team, scheduled exports (M)
- Recertification and expiry for compliance training (M)

**AI, the differentiator**
- Suggested marks for free-text answers with teacher override (M)
- Tutor chat grounded only in the course content (M)
- Adaptive practice built from missed questions (M)
- Build a course from an uploaded document or web page (M)
- Question quality review, alt-text suggestions, translation (S to M each)

**Platform**
- Multi-tenant (the `org_id` column is already there) with per-organisation themes (L)
- API tokens and webhooks (M)
- Installable web app with offline reading (M)
- LTI, SCORM, xAPI: large, and usually not worth it for a lightweight system. Skip unless a customer needs it.

## 5. Recommended order

**Phase A: foundations (do before more features).** Each item makes every later feature cheaper and safer.
1. `trust proxy`, session purge, startup config validation (S)
2. Formatter, linter and a CI workflow (S)
3. Shared HTTP helpers and a small service layer, so handlers are thin (M)
4. Capability-based permissions in one module (M)
5. Events and an audit log (M)
6. Split the tests by domain, add unit tests, add a few browser tests (M)
7. Question types as a registry (S)
8. Type checking with JSDoc and `tsc --checkJs`, which keeps the no-build-step goal (S)

**Phase B: launch readiness.** Backups and a tested restore, Dockerfile and deploy notes, structured logging, migration
checksums, a written security review, ARCHITECTURE and CONTRIBUTING docs, CHANGELOG and versioning, an accessibility pass.

**Phase C: features,** in the order that serves real use: email and reminders, bulk import and single sign-on,
recertification, course export and import, content versions, then the AI additions.

## 6. Decisions that need the owner

1. Is this for Fabulate staff only, or for outside organisations? It decides whether per-course permissions and multi-tenant
   move up or stay down.
2. How many users should it comfortably serve in the first year? It decides whether SQLite stays.
3. Is sending course material to an external AI service cleared? It decides whether the AI features are switched on in production.
4. Where will it be hosted, and who is responsible for backups?
