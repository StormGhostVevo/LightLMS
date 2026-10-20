CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Images live in the database so one file holds everything and backups stay simple.
-- The key is random, so an image address can't be guessed from another one.
CREATE TABLE images (
  key TEXT PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX images_course ON images(course_id);

ALTER TABLE courses ADD COLUMN image_key TEXT;
ALTER TABLE courses ADD COLUMN image_alt TEXT NOT NULL DEFAULT '';
