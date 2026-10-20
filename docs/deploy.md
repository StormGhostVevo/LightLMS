# Deploying and running lightlms

For whoever runs the site. It covers the settings, the first deploy, backups and how to restore them, updates and
rollback, what to watch, and a checklist to complete before real people use it.

What has been tested: the application, the backup and restore code (including a full restore drill), the container
start-up as far as it can be tested without Docker (a production-only install, production mode, the health check
command, first admin, backup, shutdown). **What has not been tested: building the Docker image itself, and any hosting
platform.** The first real deploy is the test of those. Treat the first deploy as a trial and do the checklist at the end.

## One instance, one volume

lightlms keeps everything in one SQLite file. That makes it simple to run and cheap to back up, with two rules:

- **Run exactly one copy of the server.** Two copies writing the same database file will corrupt it. Don't scale out.
  Set your platform to stop the old copy before starting the new one ("recreate", not "rolling").
- **Put `/data` on a persistent volume.** The database and its backups live there. Without a volume, every deploy
  starts from nothing.

A deploy means a short outage (seconds) while the old copy stops and the new one starts. That is normal for this design.
Comfortable capacity is hundreds of active users; beyond that, measure before promising more.

## Settings

All settings are environment variables. A mistake stops the server at start-up with a message naming the setting.
Copy `.env.example` for local use; on a platform, set them in its dashboard. Never commit real values.

| Setting | Default | What it does |
|---|---|---|
| `NODE_ENV` | (none) | Set to `production`. Turns on `Secure` cookies, upgrades insecure requests, turns the AI off unless asked, trusts one proxy |
| `PORT` | `3000` | The port to listen on. Many platforms set it for you |
| `DATABASE_PATH` | `data/lightlms.sqlite` | The database file. In the container it is `/data/lightlms.sqlite` |
| `TRUST_PROXY` | `1` in production, `0` otherwise | How many proxies sit in front. If this is wrong, rate limits apply to everyone at once (too low) or can be dodged by faking an address (too high). Set `0` if nothing sits in front |
| `BACKUP_DIR` | `backups` beside the database | Where backups go |
| `BACKUP_KEEP` | `14` | How many ordinary backups to keep. A few safety copies are kept in addition |
| `BACKUP_EVERY_HOURS` | `24` | How often to back up. `0` turns it off (not recommended) |
| `LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info` or `debug` |
| `ORG_NAME` | `lightlms` | Shown on certificates |
| `TIMEZONE` | `Australia/Sydney` | The time zone for dates on certificates |
| `AI_PROVIDER` | `off` in production, `stub` otherwise | `anthropic` sends course material to Anthropic. Leave it off until that is cleared for your data |
| `ANTHROPIC_API_KEY` | (none) | Required when `AI_PROVIDER=anthropic`. A secret: set it in the platform, never in a file |
| `AI_MODEL` | see `.env.example` | The model to use |

## First deploy

1. **Build the image** from the `Dockerfile` (or run `npm ci --omit=dev` and `node server/index.js` on a machine with Node 22).
2. **Create a persistent volume** and mount it at `/data`.
3. **Set the settings** above. At minimum `NODE_ENV=production`. Check `TRUST_PROXY` against how your platform routes traffic.
4. **Serve it over HTTPS.** Most platforms do this for you. The site sets `Secure` cookies, so it won't keep people
   signed in over plain HTTP.
5. **Start it.** Look at the logs. You should see each migration applied, `listening`, and `backup made`.
6. **Check `/health`.** It should return `{"ok":true,"version":"...","schema":"..."}`.
7. **Create the first admin** from inside the running container or service shell:

       node server/cli.js create-user you@example.com admin

   It prints a temporary password once. Sign in with it; the site makes you choose your own at once.
8. **Make a backup by hand and download it** (Manage, Backups). This proves the whole chain works.
9. **Do the restore drill** below before anyone depends on the site.

## Backups

- A backup is made automatically every `BACKUP_EVERY_HOURS` hours (the first one right at start-up if none exists).
  It is a consistent snapshot taken while the site is running, compressed, then **opened and checked** before it is
  kept. A backup that can't be opened is thrown away and an error is logged (`backup failed`).
- The newest `BACKUP_KEEP` are kept. Before any migration runs on a database that holds data, and before any restore, a
  safety copy is made too (`-pre-migrate`, `-pre-restore`).
- **A backup on the same disk as the database does not protect you from losing the disk.** Get copies off the machine:
  - Admins: **Manage, Backups, Download**, regularly. Simple and works anywhere.
  - Automatically: run `node server/backup-cli.js backup` from the platform's scheduler or a cron job elsewhere, then
    copy the newest file in the backups folder to storage in a different account or provider. For example, a daily job
    that runs `rclone copy /data/backups remote:lightlms-backups --max-age 2d`. (An example, not tested here.)
  - Keep off-site copies for longer than 14 days: the site only keeps the newest few.
- **A backup holds everything**, including people's details and password hashes. Store copies privately, encrypted if
  your storage allows, and limit who can read them.

Commands (run in the container or service shell, with the same settings as the site):

    npm run backup                       # make and check one now
    npm run backups                      # list them
    npm run verify-backup -- <file>      # check that one opens (name in the backups folder, or a path)

## Restoring (the restore drill)

Practise this on a copy before you need it. It should take a few minutes.

1. **Stop the server.** Restore refuses to run while the server is up (it checks).
2. **Pick the backup.** `npm run backups` lists them, newest first. Use `latest` for the newest ordinary one, or a name.
3. **Verify it:** `npm run verify-backup -- <name>`. It must say `OK` and show a user and course count that makes sense.
4. **Restore:** `npm run restore -- <name or latest>`.
   It checks the backup again, makes a safety copy of what is there now (`-pre-restore`), then swaps the database in.
   If anything is wrong it stops before touching the live database.
5. **Start the server.** If the backup is from an older version, any newer migrations run now (after another safety copy).
6. **Check:** sign in, open a course, open a certificate, look at the audit log's newest entries.
7. **Note what you lost:** everything changed after the backup was made is gone. Tell people.

The same steps work on a brand new machine (disaster recovery): deploy, mount an empty volume, put the backup file in the
backups folder (or give a path), and restore.

**Record the drill:** the date, the backup used, how long it took, and anything surprising. Repeat it every few months
and after big changes.

## Updating

1. Read [CHANGELOG.md](../CHANGELOG.md) for what changed.
2. Deploy the new version. On start it applies any new migrations, **after making a safety backup**
   (`-pre-migrate`). You will see `backed up before migrating` and `migration applied` in the logs.
3. Check `/health`: the `version` and `schema` should be the new ones.

The server refuses to start, with a clear message, if:
- an already-applied migration file was edited (`was changed after it was applied`), or
- the database has migrations the code doesn't know (`written by a newer version`), which stops an old version running
  on a newer database.

**Rolling back** a bad update: stop the server, deploy the previous version, and restore the `-pre-migrate` backup. That
file is the database exactly as it was before the update, so the older code accepts it. Anything people did after the
update is lost, so decide quickly.

## Watching it

- **`/health`** answers 200 with the version and schema, or 503 if the database can't be read. Point your platform's
  health check and any uptime monitor at it. The container image already has a check.
- **Logs** are one JSON object per line on stdout. Each request has an `req` id, which is also returned to the person as
  the `X-Request-Id` header, and in the message for an unexpected failure ("reference 3f9a..."). To investigate, search
  the logs for that id. Logs never contain passwords, cookies, request bodies, query strings, or IP addresses, and the
  secret part of certificate and image addresses is hidden, so they are safe to share with a support person.
- **Worth alerting on:** `"level":"error"` lines (especially `unhandled error`, `backup failed`, `health check failed`),
  repeated `401` or `429` on `/api/auth/login` (someone guessing), and no `backup made` for more than a day.
- **The audit log** (Manage, Audit log) records who changed what. It is the answer to "who did that?".

## Privacy

- **A person's data:** Manage, Users, **Export data** downloads everything held about them as JSON. The same is
  `npm run export-user -- <email>`.
- **Erasing a person:** Manage, Users, **Erase** (they type the person's email to confirm), or
  `npm run erase-user -- <email> --yes`. This removes their account details, answers, results and progress, and removes
  their name and email from the audit log. Certificates they earned stay valid but show "Name removed".
  **It does not change backups that already exist.** Those keep the old data until they are rotated out
  (the newest `BACKUP_KEEP` on site, which is 14 days with the defaults; whatever your off-site retention is). Decide your off-site retention with this in mind.
- **What is stored about people:** email, name, role, sign-in times, enrolments, progress, quiz answers and results,
  certificates, and the actions admins took (by email). Not stored: IP addresses, device details, or message content.
- If AI is switched on, course material pasted by authors is sent to Anthropic. Don't paste personal information,
  client names or rates. The page says so.

## Troubleshooting

| What you see | What it means |
|---|---|
| `Invalid configuration:` then a list | A setting is wrong. The list names it |
| `Migration ... was changed after it was applied` | Someone edited an old migration. Restore the original file; put changes in a new migration |
| `...written by a newer version` | You are running older code against a newer database. Deploy the newer code |
| `The server is running (process N). Stop it before restoring.` | Stop the server first. If it really isn't running, the process id is stale and the message won't appear |
| People are signed out on every request | `Secure` cookies over plain HTTP. Serve the site over HTTPS |
| "Too many sign-in attempts" for everyone | `TRUST_PROXY` is too low: everyone looks like one address. Check it |
| `backup failed` | The backup folder isn't writable or the disk is full. Check the volume |
| The container can't write `/data` | The entrypoint fixes ownership when it starts as root. If your platform forces a non-root user, make the volume writable by uid 1000 |

## Before real people use it

Tick each one. Dates and names go in your own notes, not here.

- [ ] First deploy done on the real platform, over HTTPS, with a persistent volume at `/data`.
- [ ] Exactly one instance, and the platform stops the old one before starting the new one.
- [ ] `NODE_ENV=production`, and `TRUST_PROXY` checked against how traffic really arrives.
- [ ] `/health` returns 200; your uptime monitor watches it.
- [ ] A backup was made, downloaded, and **restored on a copy** (the drill). The time it took is written down.
- [ ] Off-site backups happen automatically or on a schedule someone owns, and their retention is decided.
- [ ] The first admin has a real password; the temporary one is gone. A second admin exists, so one lost account isn't a lockout.
- [ ] Someone has read the logs for a day and knows what normal looks like.
- [ ] The accessibility checks that need a person have been done ([accessibility.md](accessibility.md)).
- [ ] The security review's "before launch" items are done ([security-review.md](security-review.md)).
- [ ] AI is off, or it has been confirmed that sending course material to Anthropic is allowed.
- [ ] People know where to ask for their data to be exported or erased.
