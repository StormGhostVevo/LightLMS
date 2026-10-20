# Security review

Written 20/10/2026, at version 0.3.0, as part of launch readiness. It records how the review was done, what it found
and fixed, what protections exist, and what is **not** covered. It is an internal review by the people who built the
system, helped by automated tests. **It is not an independent penetration test**, and it should not be presented as one.

## Scope

The whole application: sign-in and sessions, permissions, course content and uploads, quizzes and results, certificates,
the admin areas, backups, the logs, and the container and deployment setup. Out of scope: the hosting platform, the
network in front of it, the Anthropic service, and anyone's devices.

## How it was reviewed

- **Reading the code** with attack scenarios in mind: authentication, authorisation, injection, cross-site attacks,
  file handling, information disclosure, denial of service.
- **Automated tests** for each protection (`server/test/security.test.js`, `permissions.test.js`, `privacy.test.js`,
  `backup.test.js`, `logging.test.js` and others). Several were proven by breaking the protection on purpose and
  watching the test fail.
- **Running it in a real browser** with the final content security policy, across every kind of page, and confirming
  no violations.
- **`npm audit`** on production dependencies (clean on 20/10/2026) and a **Dependabot** configuration for ongoing updates.

Not done: an external penetration test, a scan with a tool such as OWASP ZAP, fuzzing, a review of the hosting
platform's configuration, or load testing.

## What protects what

| Threat | Protection | Checked by |
|---|---|---|
| Stolen or guessed passwords | scrypt hashes with a salt; at least 10 characters; very common passwords and ones containing the email name refused; generated temporary passwords must be replaced at first sign-in | `security.test.js`, `auth` tests |
| Password guessing | 10 attempts per 10 minutes per address, plus 10 failures per 15 minutes per account from anywhere; an unknown email is counted and answered the same, so accounts can't be discovered | `security.test.js` |
| Session theft | 32 random bytes, only a hash stored; `HttpOnly`, `SameSite=Lax`, and `Secure` in production; ended on sign-out, password change, role change and deactivation; 7 day limit | `auth.test.js`, `security.test.js` |
| Cross-site request forgery | `SameSite=Lax`, changes must be JSON, and an `Origin` that isn't this site is refused | `security.test.js` |
| Acting beyond your role | capabilities, with every admin route listed in a table; **an unlisted route is refused**; a test fails if a registered route is missing from the table; learners and signed-out visitors are tested against every admin route | `permissions.test.js` |
| Reading other people's data | learners get only their own attempts and courses they are enrolled in; others look like they don't exist | `security.test.js` |
| Seeing answer keys | learner views are built without them; reveal rules are decided on the server; attempts keep a snapshot | `question-types.test.js`, `attempts` tests |
| Script injection (XSS) | lesson HTML is sanitised to a short tag list with only this site's own images; all other text is shown as text; the browser code builds elements and never pastes strings into HTML; certificate pages escape everything | `text.test.js`, `appearance.test.js` |
| Script running if XSS slipped through | content security policy: scripts, styles, images, connections, and forms only from this site; no inline script or style; no framing; no `eval` | `security.test.js`, real-browser run |
| Hostile uploads | type decided from the file's own bytes; PNG, JPEG, WebP, GIF only (no SVG); 2 MB; random addresses; `nosniff` | `appearance.test.js` |
| Injection into the database | every query uses parameters; the one place a table name is built into SQL is guarded by an allowlist | code review |
| Reading files off the server | only `public/` is served; backup downloads accept only strictly formatted names; unknown addresses get a fixed "Not found" | `security.test.js`, `backup.test.js` |
| Flooding | 600 requests a minute per address on the API; extra limits on sign-in, AI, quizzes, backups and public lookups; small body limits | `security.test.js` |
| Cached personal data | `Cache-Control: no-store` on every API answer | `security.test.js` |
| Leaks in logs and errors | requests are logged without bodies, cookies, queries, headers or IPs; known secret field names are redacted; certificate codes and image keys are hidden; an unexpected error shows the person only a reference | `logging.test.js` |
| Lost or damaged data | scheduled backups that are opened and verified; a backup before every migration; checksums stop edited migrations; a tested restore | `backup.test.js` |
| Unaccountable changes | an audit log of important actions, without secrets or IPs | `audit.test.js` |
| Personal information kept too long | export and erase tools that also scrub the audit log; certificates stay valid under "Name removed" | `privacy.test.js` |

## Found and fixed during the review

| Finding | Severity | Fix |
|---|---|---|
| With a proxy in front, every visitor looked like one address, so the sign-in limit would have locked everyone out together | High before launch | `TRUST_PROXY`, defaulting to one proxy in production |
| Sign-in was only limited per address, so guesses spread over many machines were unlimited | Medium | Per-account limit |
| No defence if a browser could be tricked into sending a change from another site, beyond `SameSite` | Medium | `Origin` check |
| Content security policy allowed inline styles and `https:` styles; the certificate page used an inline style | Medium | Strict policy; the style moved to a file |
| Very weak passwords were allowed if they were 10 characters long | Medium | Common-password and email-name checks |
| Expired sessions were never deleted | Low | Hourly sweep |
| API answers could be cached by a browser or proxy | Low | `no-store` |
| The default "not found" page repeated the address and named the framework | Low | A fixed short answer |
| One SQL statement had a table name built into it (from fixed internal values) | Low | Allowlist guard |
| No record of who changed what | Medium (accountability) | Audit log |
| No safe way to remove a person's data | Medium (privacy) | Export and erase |

## Residual risks and gaps (be honest about these)

**Accounts**
- No two-factor authentication and no single sign-on. A guessed or phished password is a full compromise of that account.
- No email, so no self-service password reset or email verification. Admins reset passwords and hand over temporary
  ones, which travel by whatever channel the admin uses. Do that privately.
- Sessions last a fixed 7 days with no idle timeout. There is no "sign out everywhere" button (changing the password does it).
- The per-account lock can be used to annoy someone: an attacker can keep an account locked by failing on purpose.
  It doesn't let them in. Limits are kept in memory, so a restart forgives them.
- Per-address limits can catch many people behind one shared office address.

**Permissions**
- Any author can edit, publish and see the results of **every** course. Fine for one trusted team; not for separate
  teams or outside organisations. Per-course ownership is the next step if that matters.
- Admins can read everything, including through backups (which hold password hashes). Limit who is an admin, and who
  can reach the hosting volume.

**Data**
- Backups keep old data until they are rotated out, including data later erased. Plan off-site retention with that in mind.
- Quiz answers can contain personal information if authors write free-text questions. They are deleted on erase.
- Images and certificates are public to anyone who has the address (random keys and codes). Treat the address as the
  secret. A certificate shows a name, a course title and a date.
- Records are not encrypted at rest by the application. Rely on the platform's volume encryption and restrict access to it.

**Availability**
- One process and one file. A bug that blocks the process (a very slow database call) pauses everyone. Heavy reports
  (the gradebook for a very large course) are not optimised.
- No automatic failover. Recovery is a restore, which means minutes of work plus whatever was lost since the last backup.

**AI**
- Pasted course material is sent to Anthropic when the AI is on. Everything the AI writes is cleaned, validated, and
  starts as a draft for a person to approve, so a misleading or manipulated output is caught only if the person reads it.
  The system treats source text as data, but prompt injection through pasted material is a known weakness of any such
  feature. Don't paste untrusted documents.
- The real AI has not been tested end to end against the live service.

**Not verified**
- Regular-expression and parser behaviour under hostile input (no fuzzing).
- Behaviour behind a real proxy or CDN other than by the tests that simulate forwarded addresses.
- The Docker image build and the hosting platform's settings (see [deploy.md](deploy.md)).
- A real screen reader, keyboard-only use, and zoom (see [accessibility.md](accessibility.md)).

## Before launch

Do these, in addition to the checklist in [deploy.md](deploy.md):

1. Run the CI workflow on GitHub and fix anything it finds. It has not run there yet.
2. Deploy to a test environment, then check the real response headers and cookie flags on the live address.
3. Have someone who didn't build it try to break it, ideally a professional penetration test of the deployed system.
   This review is not a substitute.
4. Decide whether two-factor or single sign-on is needed for admins. If the site holds anything sensitive, it probably is.
5. Decide whether authors should be limited to their own courses.
6. Confirm who can reach the hosting volume, the backups, and the platform's logs, and remove anyone who shouldn't.
7. Set up alerts on the log lines named in the deployment guide.
8. Decide whether the AI is allowed to see your course material. Until that is cleared, leave it off.

## Keeping it secure

- `npm run check` runs every test, including the security ones, before each change reaches `main`. Don't merge on red.
- Dependabot opens weekly update pull requests. Read the change log of anything that touches sign-in, sessions or file handling.
- Any new admin route must be added to `ADMIN_ROUTES`. A new capability must be added to the permission matrix test.
- Re-run this review after any change to sign-in, sessions, permissions, uploads, backups, or the content security policy.
- Report a vulnerability to whoever runs the site, privately, before telling anyone else.
