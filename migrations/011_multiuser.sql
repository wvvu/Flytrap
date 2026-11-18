-- Multi-user accounts, flexible mailbox/domain allocations, per-user mail state, and message stars.
ALTER TABLE messages ADD COLUMN starred_at INTEGER;
ALTER TABLE outbox ADD COLUMN user_id TEXT;

CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL,
  display_name   TEXT,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'member',
  status         TEXT NOT NULL DEFAULT 'active',
  quota_send_day INTEGER NOT NULL DEFAULT 100,
  notes          TEXT,
  reset_seal     TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);

CREATE UNIQUE INDEX idx_users_username_lower ON users(lower(username));

CREATE TABLE user_allocations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  localpart  TEXT NOT NULL,
  domain     TEXT NOT NULL,
  can_send   INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, localpart, domain)
);

CREATE INDEX idx_user_allocations_user ON user_allocations(user_id);
CREATE INDEX idx_user_allocations_domain ON user_allocations(domain, localpart);

CREATE TABLE user_message_state (
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id     TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  read_at        INTEGER,
  trashed_at     INTEGER,
  starred_at     INTEGER,
  deleted_at     INTEGER,
  label_override TEXT,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, message_id)
);

CREATE INDEX idx_user_msg_state_user ON user_message_state(user_id, trashed_at, deleted_at);

CREATE TABLE user_settings (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE INDEX idx_outbox_user_created ON outbox(user_id, created_at DESC);
CREATE INDEX idx_messages_starred ON messages(starred_at) WHERE starred_at IS NOT NULL;
