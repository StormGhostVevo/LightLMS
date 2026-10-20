# Contributing

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first. This page is the working agreement.

## Set up

Node 22 or later.

    npm install
    cp .env.example .env
    npm run seed-demo      # sample accounts and a course (development only)
    npm run dev            # http://localhost:3000

## Before you push

    npm run check

It runs formatting (Prettier), lint (ESLint), type checks (TypeScript over JSDoc) and all tests. CI runs the same and
also audits dependencies. A change that fails `check` is not finished.

## Standards

- **Format** is Prettier's, with the settings in `.prettierrc.json`. Run `npm run format` and don't argue with it.
- **Lint** rules are in `eslint.config.js`. Two matter most: `no-shadow` (a local name must not hide another; it once
  broke a page silently) and `eqeqeq`.
- **Types** are JSDoc comments checked by `tsc`, so there is still no build step. Annotate function parameters and
  return values when the type isn't obvious. Don't use `any` to silence an error you don't understand.
- **No build step, no front-end framework.** Browser code is plain modules. Build elements with `h()`, and insert them
  with `put()` and `add()` (plain `append` turns a null into the text "null").
- **Keep dependencies few.** Each one is a long-term cost. Ask whether twenty lines of code would do.
- **Comments** explain why, not what. Write them for the next person.
- **Language.** User-facing text is plain, warm and short, in Australian English (organise, colour, centre). Dates are
  DD/MM/YYYY. No em dashes.

## Tests

Every change that alters behaviour comes with a test. Put the test next to the area it belongs to. Prefer a direct
service or unit test for rules, and an API test for permissions and wiring. A bug fix starts with a test that fails.

Before relying on a new test, break the code on purpose and watch the test fail. A test that cannot fail proves nothing.

## Changes to the database

- Add a new numbered migration. Never edit one that has been applied anywhere.
- Migrations only go forward. Keep existing data working.
- Anything that stores personal information needs a reason, and a way to delete it.

## Security rules

- Check permissions on the server. Hiding a button is never protection.
- Add every new admin route to `ADMIN_ROUTES`. Unlisted routes are refused.
- Treat all input as hostile: validate it, sanitise HTML, and never build HTML from user text.
- Never send an answer key, a password, a session id or a stack trace to a browser.
- Never log or audit secrets, passwords, session ids or personal answers.
- Don't paste real client, creator or personal data into tests, examples or issues.

## Commits and releases

Small commits, each one passing `npm run check`, each message saying what changed and why. Update
[CHANGELOG.md](CHANGELOG.md) under "Unreleased" for anything a user or operator would notice. Versions follow
semantic versioning; the version lives in `package.json` and shows in `/health`.
