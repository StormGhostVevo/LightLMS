ALTER TABLE courses ADD COLUMN certificate_enabled INTEGER NOT NULL DEFAULT 1 CHECK (certificate_enabled IN (0, 1));

-- A certificate is a permanent record: the name and course title are copied in when it is issued, and it
-- survives the course being deleted (course_id becomes NULL), so a printed certificate stays verifiable.
CREATE TABLE certificates (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,                       -- public, unguessable, e.g. LL-7K2QM-9XBTA
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  recipient_name TEXT NOT NULL,
  course_title TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT NOT NULL DEFAULT ''
);
-- One per person per course (enforced while the course exists).
CREATE UNIQUE INDEX certificates_user_course ON certificates(user_id, course_id) WHERE course_id IS NOT NULL;
CREATE INDEX certificates_course ON certificates(course_id);
