CREATE TABLE IF NOT EXISTS live_state (
 id INTEGER PRIMARY KEY CHECK(id=1), account_hash TEXT NOT NULL,
 recorded_at TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
 recorded_at TEXT PRIMARY KEY, balance REAL NOT NULL, equity REAL NOT NULL,
 cashflow REAL NOT NULL
);
