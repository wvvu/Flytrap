-- A short name for an address you keep notes on. Empty means show the address itself.
ALTER TABLE mailbox_history ADD COLUMN display_name TEXT;
