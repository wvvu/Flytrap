-- Multi-user accounts, flexible mailbox/domain delegation, and isolated per-user message states.
-- Raw EML files remain content-addressed and shared once on disk; reading, starring, trashing,
-- or deleting in one user's inbox never mutates another recipient's copy.

CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL,
  display_name   TEXT,
  password_hash  TEXT NOT NULL,
  recovery_email TEXT,
  role           TEXT NOT NULL DEFAULT 'member',
  catch_all      INTEGER NOT NULL DEFAULT 0,
  disabled_at    INTEGER,
  settings_json  TEXT NOT NULL DEFAULT '{}',
  last_login_at  INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_users_username_lower ON users(lower(username));

CREATE TABLE user_mailboxes (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  localpart    TEXT NOT NULL,
  domain       TEXT NOT NULL,
  display_name TEXT,
  can_send     INTEGER NOT NULL DEFAULT 1,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  UNIQUE(user_id, localpart, domain)
);

CREATE INDEX idx_user_mailboxes_lookup ON user_mailboxes(domain, localpart);
CREATE INDEX idx_user_mailboxes_user ON user_mailboxes(user_id);

CREATE TABLE user_messages (
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id     TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  recipient_addr TEXT,
  received_at    INTEGER NOT NULL,
  read_at        INTEGER,
  starred_at     INTEGER,
  trashed_at     INTEGER,
  label_override TEXT,
  PRIMARY KEY (user_id, message_id)
);

CREATE INDEX idx_user_messages_inbox ON user_messages(user_id, trashed_at, received_at DESC, message_id DESC);
CREATE INDEX idx_user_messages_unread ON user_messages(user_id, trashed_at, read_at);
CREATE INDEX idx_user_messages_starred ON user_messages(user_id, starred_at, received_at DESC) WHERE starred_at IS NOT NULL;
CREATE INDEX idx_user_messages_mid ON user_messages(message_id);

ALTER TABLE sessions ADD COLUMN user_id TEXT;
CREATE INDEX idx_sessions_user ON sessions(user_id);

ALTER TABLE outbox ADD COLUMN user_id TEXT;
CREATE INDEX idx_outbox_user_created ON outbox(user_id, created_at DESC);

CREATE TRIGGER trg_messages_route_after_insert
AFTER INSERT ON messages
BEGIN
  INSERT OR IGNORE INTO user_messages (user_id, message_id, recipient_addr, received_at, read_at, trashed_at)
  SELECT um.user_id, NEW.id, lower(trim(je.value)), NEW.received_at, NEW.read_at, NEW.trashed_at
  FROM json_each(CASE WHEN json_valid(NEW.envelope_to) AND json_type(NEW.envelope_to) = 'array' THEN NEW.envelope_to ELSE '[]' END) je
  JOIN user_mailboxes um
    ON um.localpart != '*'
   AND instr(trim(je.value), '@') > 1
   AND lower(substr(trim(je.value), instr(trim(je.value), '@') + 1)) = um.domain
   AND (
     lower(substr(trim(je.value), 1, instr(trim(je.value), '@') - 1)) = um.localpart
     OR lower(substr(trim(je.value), 1, instr(trim(je.value), '@') - 1)) LIKE um.localpart || '+%'
   );

  INSERT OR IGNORE INTO user_messages (user_id, message_id, recipient_addr, received_at, read_at, trashed_at)
  SELECT um.user_id, NEW.id, lower(trim(je.value)), NEW.received_at, NEW.read_at, NEW.trashed_at
  FROM json_each(CASE WHEN json_valid(NEW.envelope_to) AND json_type(NEW.envelope_to) = 'array' THEN NEW.envelope_to ELSE '[]' END) je
  JOIN user_mailboxes um
    ON um.localpart = '*'
   AND instr(trim(je.value), '@') > 1
   AND lower(substr(trim(je.value), instr(trim(je.value), '@') + 1)) = um.domain
  WHERE NOT EXISTS (
    SELECT 1 FROM user_mailboxes exact
    WHERE exact.localpart != '*'
      AND exact.domain = um.domain
      AND (
        lower(substr(trim(je.value), 1, instr(trim(je.value), '@') - 1)) = exact.localpart
        OR lower(substr(trim(je.value), 1, instr(trim(je.value), '@') - 1)) LIKE exact.localpart || '+%'
      )
  );

  INSERT OR IGNORE INTO user_messages (user_id, message_id, recipient_addr, received_at, read_at, trashed_at)
  SELECT u.id, NEW.id, NULL, NEW.received_at, NEW.read_at, NEW.trashed_at
  FROM users u
  WHERE u.catch_all = 1
    AND (
      json_valid(NEW.envelope_to) = 0
      OR json_type(NEW.envelope_to) != 'array'
      OR json_array_length(NEW.envelope_to) = 0
      OR EXISTS (
        SELECT 1 FROM json_each(NEW.envelope_to) je
        WHERE NOT EXISTS (
          SELECT 1 FROM user_mailboxes um
          WHERE instr(trim(je.value), '@') > 1
            AND lower(substr(trim(je.value), instr(trim(je.value), '@') + 1)) = um.domain
            AND (
              um.localpart = '*'
              OR lower(substr(trim(je.value), 1, instr(trim(je.value), '@') - 1)) = um.localpart
              OR lower(substr(trim(je.value), 1, instr(trim(je.value), '@') - 1)) LIKE um.localpart || '+%'
            )
        )
      )
    );
END;
