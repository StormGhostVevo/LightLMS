-- 'manual': staff enrol people. 'open': any signed-in user can enrol themselves.
ALTER TABLE courses ADD COLUMN enrolment TEXT NOT NULL DEFAULT 'manual' CHECK (enrolment IN ('manual', 'open'));

CREATE TABLE enrolments (
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enrolled_at TEXT NOT NULL,
  enrolled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- null when the learner enrolled themselves
  PRIMARY KEY (course_id, user_id)
);
CREATE INDEX enrolments_user ON enrolments(user_id);
