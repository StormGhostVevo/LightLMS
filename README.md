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

## API (first slice)

Authoring routes need `Authorization: Bearer <ADMIN_TOKEN>` (`dev-token` in development).

- `POST /api/admin/ai/draft-course` `{ text }` creates a draft course with lessons and draft questions
- `POST /api/admin/courses/:id/quiz/generate` `{ count }` adds draft questions from the lessons
- `PATCH /api/admin/questions/:id` edit or approve (`status: "approved"`); `DELETE` removes
- `POST /api/admin/courses/:id/publish`
- `GET /api/courses`, `GET /api/courses/:id` published courses; only approved questions, no answers
- `POST /api/courses/:id/quiz` `{ answers: { questionId: optionIndex } }` marked on the server
