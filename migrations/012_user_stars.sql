-- Per-viewer stars live on user_message_state. messages has no starred_at column.
ALTER TABLE user_message_state ADD COLUMN starred_at INTEGER;
