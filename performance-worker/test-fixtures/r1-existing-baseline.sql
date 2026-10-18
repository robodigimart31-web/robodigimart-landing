-- Synthetic test-account identity; public payload values copied from the
-- currently displayed Landing Page baseline, not from broker trade history.
INSERT INTO live_state(id,account_hash,recorded_at,payload) VALUES (
  1,
  '9b4a3df784ac93f737df8bfd5272393322a6f356bacefba3cfcfb3aec683f9c8',
  '2026-10-18T09:57:37.000Z',
  '{"scope":"helix_magic_681","schema_version":3,"chart_basis":"profit","report":{"series_slug":"quadriga","kind":"live","label":"HELIX QUADRIGA","account_type":"real","broker_label":null,"currency":"USC","symbol":"XAUUSDc","initial_balance":null,"net_profit":0,"win_rate":null,"profit_factor":null,"max_drawdown_pct":null,"total_trades":0,"period_start":"2026-10-04T00:00:00Z","period_end":"2026-10-16T20:58:07Z","updated_at":"2026-10-18T09:57:37.000Z"},"monthly":[],"points":[{"recorded_at":"2026-10-04T00:00:00Z","balance":null,"equity":null,"profit":0},{"recorded_at":"2026-10-16T20:58:07Z","balance":null,"equity":null,"profit":0}]}'
);
INSERT INTO snapshots(recorded_at,balance,equity,cashflow) VALUES
  ('2026-10-10T08:23:23.000Z',49174.8,49174.8,0);

