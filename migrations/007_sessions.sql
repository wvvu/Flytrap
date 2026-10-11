-- Login sessions survive a process restart. The cookie only holds the id.
CREATE TABLE sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_sessions_expires ON sessions(expires_at);
