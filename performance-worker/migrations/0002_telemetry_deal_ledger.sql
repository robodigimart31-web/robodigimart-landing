-- Draft only. Apply only after the explicit R1 production GO.
-- Freeze the exact pre-ledger public payload; never infer raw deals from it.
CREATE TABLE IF NOT EXISTS telemetry_legacy_baseline (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  account_hash TEXT,
  recorded_at TEXT,
  payload TEXT NOT NULL,
  provenance TEXT NOT NULL DEFAULT 'copied_from_live_state_before_ledger',
  captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO telemetry_legacy_baseline(id,account_hash,recorded_at,payload)
SELECT 1,account_hash,recorded_at,payload FROM live_state WHERE id=1;

CREATE TABLE IF NOT EXISTS telemetry_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  account_hash TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('legacy_baseline','ledger_approved_waiting_publish','ledger_verified')),
  revision INTEGER NOT NULL DEFAULT 0,
  last_operation TEXT,
  last_accepted_at TEXT,
  published_revision INTEGER NOT NULL DEFAULT 0,
  coverage_attested_at TEXT,
  coverage_attestation TEXT
);
INSERT OR IGNORE INTO telemetry_control(id,account_hash,mode,last_accepted_at)
SELECT 1,account_hash,'legacy_baseline',recorded_at FROM live_state WHERE id=1;
INSERT OR IGNORE INTO telemetry_control(id,account_hash,mode)
SELECT 1,NULL,'legacy_baseline' WHERE NOT EXISTS (SELECT 1 FROM telemetry_control WHERE id=1);

CREATE TABLE IF NOT EXISTS telemetry_deals (
  account_hash TEXT NOT NULL,
  deal_ticket TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(account_hash, deal_ticket)
);
CREATE TABLE IF NOT EXISTS telemetry_deal_revisions (
  account_hash TEXT NOT NULL,
  deal_ticket TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  previous_payload TEXT NOT NULL,
  replacement_payload TEXT NOT NULL,
  PRIMARY KEY(account_hash,deal_ticket,observed_at)
);
CREATE TABLE IF NOT EXISTS telemetry_candidate (
  id INTEGER PRIMARY KEY CHECK(id=1),
  account_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  payload TEXT NOT NULL
);

-- Prevent an older Worker binary from replacing the frozen public state after
-- rollback. Only a revision-fenced candidate written by this Worker transaction
-- may update live_state; a legacy Worker has no candidate/control token.
CREATE TRIGGER IF NOT EXISTS telemetry_guard_live_state_update
BEFORE UPDATE ON live_state
WHEN NOT EXISTS (
  SELECT 1 FROM telemetry_control c
  JOIN telemetry_candidate p ON p.id=1
  WHERE c.id=1
    AND c.mode IN ('ledger_approved_waiting_publish','ledger_verified')
    AND c.last_accepted_at=NEW.recorded_at
    AND c.revision=p.revision
    AND p.account_hash=NEW.account_hash
    AND p.recorded_at=NEW.recorded_at
    AND p.payload=NEW.payload
)
BEGIN
  SELECT RAISE(IGNORE);
END;

