-- Multi-user accounts, mailbox allocations, and per-user message state overlay.
CREATE TABLE users (
  id                  TEXT PRIMARY KEY,
  username            TEXT NOT NULL,
  display_name        TEXT,
  recovery_email      TEXT,
  role                TEXT NOT NULL DEFAULT 'member',
  password_hash       TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active',
  quota_send_per_day  INTEGER NOT NULL DEFAULT 100,
  notes               TEXT,
  last_login_at       INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_users_username_lower ON users(lower(username));

CREATE TABLE user_mailboxes (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  localpart     TEXT NOT NULL,
  domain        TEXT NOT NULL,
  display_name  TEXT,
  notes         TEXT,
  can_send      INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  UNIQUE(localpart, domain)
);

CREATE INDEX idx_user_mailboxes_user ON user_mailboxes(user_id);
CREATE INDEX idx_user_mailboxes_domain ON user_mailboxes(domain, localpart);

CREATE TABLE user_message_state (
  user_id       TEXT NOT NULL,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  read_at       INTEGER,
  trashed_at    INTEGER,
  deleted_at    INTEGER,
  manual_label  TEXT,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, message_id)
);

CREATE INDEX idx_ums_user_state ON user_message_state(user_id, deleted_at, trashed_at, read_at);
CREATE INDEX idx_ums_message ON user_message_state(message_id);

ALTER TABLE outbox ADD COLUMN user_id TEXT;
UPDATE outbox SET user_id = 'owner' WHERE user_id IS NULL;
CREATE INDEX idx_outbox_user_created ON outbox(user_id, created_at DESC);
