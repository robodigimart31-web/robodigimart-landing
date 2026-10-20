CREATE TABLE IF NOT EXISTS telemetry_restore_batches (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  restore_batch_id TEXT NOT NULL UNIQUE,
  source_name TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  account_hash TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  selection_filter TEXT NOT NULL,
  source_deal_count INTEGER NOT NULL CHECK (source_deal_count >= 0),
  expected_new_deal_count INTEGER NOT NULL CHECK (expected_new_deal_count >= 0),
  net_profit REAL NOT NULL,
  currency TEXT NOT NULL,
  magic_unverified_count INTEGER NOT NULL CHECK (magic_unverified_count >= 0),
  unmapped_position_count INTEGER NOT NULL CHECK (unmapped_position_count >= 0),
  owner_approved_at TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

