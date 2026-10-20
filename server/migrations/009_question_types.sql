-- Existing questions are all multiple choice. Other types keep their answer key in `spec` (JSON); options stay a JSON array.
ALTER TABLE questions ADD COLUMN type TEXT NOT NULL DEFAULT 'mcq'
  CHECK (type IN ('mcq', 'true_false', 'multiple_response', 'short_answer', 'numeric', 'matching'));
ALTER TABLE questions ADD COLUMN spec TEXT NOT NULL DEFAULT '{}';
