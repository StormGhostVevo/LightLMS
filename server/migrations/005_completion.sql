-- What finishing a course means: every lesson marked done, the quiz passed, or both.
-- If a course has no approved quiz questions, the quiz requirement is ignored.
ALTER TABLE courses ADD COLUMN completion_rule TEXT NOT NULL DEFAULT 'both' CHECK (completion_rule IN ('lessons', 'quiz', 'both'));

-- Learners mark lessons done themselves (like Moodle's manual completion).
CREATE TABLE lesson_progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, lesson_id)
);
CREATE INDEX lesson_progress_course_user ON lesson_progress(course_id, user_id);

-- Written once, when the requirements are first met. It is never revoked: adding a lesson later, or
-- unenrolling, doesn't take away a completion someone earned (this is also what certificates will key on).
CREATE TABLE course_completions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, course_id)
);
