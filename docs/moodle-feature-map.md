# Moodle feature map

How each major Moodle capability maps to lightlms. This is a clean-room reimplementation: features are rebuilt from
their publicly documented behaviour. No Moodle code is copied (Moodle is GPL v3 PHP; copying it would force this
project under the GPL and it would not run on Node anyway).

Status: **done** (in the repo), **next** (planned first), **later**, **skip** (deliberately left out to stay light).

| Moodle area | What it does | lightlms approach | Status |
|---|---|---|---|
| Courses | Container for learning content | `courses` table, draft/published | done |
| Resources: Page / Book | Rich-text content, chaptered | `lessons` (sanitised HTML), ordered | done |
| Quiz: multiple choice | Auto-marked questions | `questions`, marked server-side, answers never sent to learners | done |
| Question bank | Reusable questions | Questions are per course for now; a shared bank with tags later | later |
| Quiz: other types | True/false, short answer, matching, numeric | Add `kind` column; true/false and short answer first | next |
| Quiz settings | Attempts, time limit, pass mark, shuffle | Per-course settings; attempts stored | next |
| Quiz attempts and review | Stored attempts, feedback | `attempts` table, show explanations after submit | next |
| Gradebook | Scores per learner/course | Derived from attempts; per-course and per-learner views | next |
| Users and roles | Admin, teacher, student | `users` + role (admin, author, learner); replaces the single staff token | next |
| Authentication | Manual, OAuth, SSO | Magic link or OAuth (provider TBD); sessions server-side | next |
| Enrolment | Who can access which course | `enrolments` table, manual and by group | next |
| Groups / cohorts | Bulk enrolment, group work | Groups table feeding enrolment rules | later |
| Completion tracking | Activity and course completion | Lesson-viewed + quiz-passed rules, per learner | next |
| Certificates | Plugin: award on completion | Unique per-learner ID, printable page | later |
| Badges | Awards for achievements | Reuse completion rules | later |
| Assignments | Submit files, teacher grades | Text/file submission, rubric; AI-assisted marking suggestions with teacher override | later |
| Forums / messaging | Discussion | Skip initially; link out to Slack/Teams | skip |
| Workshop / peer review | Peer assessment | Skip | skip |
| Calendar / events | Deadlines | Due dates on courses, simple iCal feed | later |
| Notifications | Email/popup alerts | Email provider TBD; enrolment and due-date reminders | later |
| Reports and analytics | Logs, activity, at-risk | Completion, scores, weak-question report | later |
| Backup and restore | Course export/import | Course JSON export/import; SQLite backups | later |
| SCORM / H5P / LTI | Standards-based content | LTI later if needed; SCORM skip (heavy) | skip |
| Plugins and themes | Extensibility | Skip: one small codebase is the point | skip |
| Mobile app | Native app | Responsive web only | skip |
| Multi-language | Language packs | Australian English first; string table later | later |
| Multi-tenant | Many sites | `org_id` already on content tables | later |

## AI features Moodle does not have (the point of lightlms)

- **Done:** draft a course from pasted source material; generate quiz questions from lessons; humans approve AI questions before learners see them.
- **Next:** explanations shown after each attempt; regenerate a single weak question; flag questions most learners miss.
- **Later:** tutor chat grounded only in the course content; AI marking suggestions for short answers with teacher override; adaptive practice built from missed questions.

## Suggested build order

1. Users, roles and sessions (replace the staff token).
2. Enrolment and per-learner access.
3. Attempts, pass marks, explanations, gradebook.
4. More question types and a UI for authors and learners.
5. Completion tracking and certificates.
6. Reports, then notifications.
