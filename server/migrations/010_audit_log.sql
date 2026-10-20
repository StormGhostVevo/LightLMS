-- Who did what, and when. The actor's email is copied in (not just their id), so the record still makes sense
-- after an account is deactivated, and no foreign key means deleting a user never deletes the history.
-- No IP addresses are stored, to keep personal information to a minimum.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor_id INTEGER,
  actor_email TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  target_label TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_at ON audit_log(id DESC);
CREATE INDEX audit_log_action ON audit_log(action);
