-- Outbound letters stay out of the inbox. The private key never leaves this table.
CREATE TABLE dkim_keys (
  domain      TEXT NOT NULL,
  selector    TEXT NOT NULL,
  private_pem TEXT NOT NULL,
  public_p    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (domain, selector)
);

CREATE TABLE outbox (
  id            TEXT PRIMARY KEY,
  sha256        TEXT NOT NULL,
  raw_path      TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  from_addr     TEXT NOT NULL,
  to_addrs      TEXT NOT NULL,
  subject       TEXT NOT NULL,
  domain_known  INTEGER NOT NULL,
  dkim_selector TEXT,
  status        TEXT NOT NULL,
  accepted      TEXT NOT NULL DEFAULT '[]',
  smtp_response TEXT,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_outbox_created ON outbox(created_at DESC);
