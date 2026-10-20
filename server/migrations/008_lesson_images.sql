-- 'cover' is the course's one cover image; 'lesson' images are placed inside lesson text.
ALTER TABLE images ADD COLUMN kind TEXT NOT NULL DEFAULT 'cover' CHECK (kind IN ('cover', 'lesson'));
CREATE INDEX images_course_kind ON images(course_id, kind);
