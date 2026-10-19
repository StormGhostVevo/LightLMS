-- org_id is on every content table so multi-tenant can come later without reshaping the data.
CREATE TABLE orgs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);
INSERT INTO orgs (id, name) VALUES (1, 'Default');

CREATE TABLE courses (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL DEFAULT 1 REFERENCES orgs(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE lessons (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL            -- sanitised HTML
);
CREATE INDEX lessons_course ON lessons(course_id, position);

-- Multiple-choice questions. AI-made questions start as 'draft' and a person approves them;
-- only 'approved' questions are ever shown to learners.
CREATE TABLE questions (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  options TEXT NOT NULL,        -- JSON array of strings
  answer INTEGER NOT NULL,      -- index into options
  explanation TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved'))
);
CREATE INDEX questions_course ON questions(course_id, position);
