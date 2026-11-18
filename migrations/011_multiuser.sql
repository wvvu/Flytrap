-- Multi-user accounts, flexible mailbox allocations, per-user message state, and preferences.
-- Raw EML files on disk stay deduplicated by SHA-256 across accounts.

CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  username          TEXT NOT NULL,
  display_name      TEXT,
  password_hash     TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  daily_send_limit  INTEGER NOT NULL DEFAULT 50,
  notes             TEXT,
  disabled_at       INTEGER,
  last_login_at     INTEGER,
  reset_seal        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_users_username_lower ON users(lower(username));

CREATE TABLE user_mailboxes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('exact', 'prefix', 'domain')),
  localpart   TEXT NOT NULL,
  domain      TEXT NOT NULL,
  can_send    INTEGER NOT NULL DEFAULT 1,
  notes       TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE(kind, localpart, domain)
);

CREATE INDEX idx_user_mailboxes_user ON user_mailboxes(user_id);
CREATE INDEX idx_user_mailboxes_domain ON user_mailboxes(domain);

CREATE TABLE user_message_state (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  read_at       INTEGER,
  trashed_at    INTEGER,
  purged_at     INTEGER,
  manual_label  TEXT,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, message_id)
);

CREATE INDEX idx_user_msg_state_lookup ON user_message_state(user_id, trashed_at, purged_at);

CREATE TABLE user_preferences (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  panel_title TEXT,
  blocked     TEXT NOT NULL DEFAULT '[]',
  senders     TEXT NOT NULL DEFAULT '[]',
  mailboxes   TEXT NOT NULL DEFAULT '[]',
  updated_at  INTEGER NOT NULL
);

ALTER TABLE outbox ADD COLUMN user_id TEXT;
CREATE INDEX idx_outbox_user_created ON outbox(user_id, created_at DESC);
