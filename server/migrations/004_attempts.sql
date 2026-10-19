-- Quiz rules per course. max_attempts NULL means unlimited.
-- show_answers: when a learner sees which option was correct and the explanation after submitting.
ALTER TABLE courses ADD COLUMN pass_mark INTEGER NOT NULL DEFAULT 70 CHECK (pass_mark BETWEEN 0 AND 100);
ALTER TABLE courses ADD COLUMN max_attempts INTEGER CHECK (max_attempts IS NULL OR max_attempts BETWEEN 1 AND 50);
ALTER TABLE courses ADD COLUMN show_answers TEXT NOT NULL DEFAULT 'after_pass' CHECK (show_answers IN ('never', 'after_pass', 'always'));

-- detail is a snapshot of each question as the learner saw it (JSON), so later edits to a question
-- never change what an old attempt shows. Attempts are never edited.
CREATE TABLE attempts (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  total INTEGER NOT NULL,
  percent INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  pass_mark INTEGER NOT NULL,        -- the mark in force when it was taken
  detail TEXT NOT NULL,
  submitted_at TEXT NOT NULL
);
CREATE INDEX attempts_course_user ON attempts(course_id, user_id);
CREATE INDEX attempts_user ON attempts(user_id);
