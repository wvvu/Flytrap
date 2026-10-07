-- Existing letters were already opened by use. New letters stay unread until opened.
ALTER TABLE messages ADD COLUMN read_at INTEGER;
UPDATE messages SET read_at = received_at WHERE read_at IS NULL;
