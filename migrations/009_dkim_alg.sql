-- Which key signs outbound mail. Rows from before this migration are RSA 2048.
ALTER TABLE dkim_keys ADD COLUMN alg TEXT NOT NULL DEFAULT 'rsa';
