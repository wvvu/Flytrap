-- Reply links. Null means the row has not been scanned, or it is not part of a chain.
ALTER TABLE messages ADD COLUMN in_reply_to TEXT;
ALTER TABLE messages ADD COLUMN ref_ids TEXT;
ALTER TABLE messages ADD COLUMN thread_key TEXT;
ALTER TABLE outbox ADD COLUMN message_id TEXT;
ALTER TABLE outbox ADD COLUMN in_reply_to TEXT;
ALTER TABLE outbox ADD COLUMN ref_ids TEXT;
ALTER TABLE outbox ADD COLUMN thread_key TEXT;

CREATE INDEX idx_messages_thread ON messages(thread_key);
CREATE INDEX idx_messages_in_reply ON messages(in_reply_to);
CREATE INDEX idx_outbox_message_id ON outbox(message_id);
CREATE INDEX idx_outbox_thread ON outbox(thread_key);
CREATE INDEX idx_outbox_in_reply ON outbox(in_reply_to);
