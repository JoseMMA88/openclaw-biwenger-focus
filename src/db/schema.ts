export const SCHEMA_VERSION = 1;

export const INIT_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS focus_tasks (
  id TEXT PRIMARY KEY,
  player_query TEXT NOT NULL,
  player_id INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  competition TEXT,
  max_price INTEGER NOT NULL,
  start_when_remaining_sec INTEGER NOT NULL,
  bid_step INTEGER NOT NULL,
  poll_sec INTEGER NOT NULL,
  cooldown_sec INTEGER NOT NULL,
  status TEXT NOT NULL,
  stop_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  next_poll_at INTEGER NOT NULL,
  lock_token TEXT,
  lock_expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS focus_runtime (
  focus_id TEXT PRIMARY KEY,
  last_seen_price INTEGER,
  last_seen_until INTEGER,
  last_bid_amount INTEGER,
  last_bid_at INTEGER,
  missing_since INTEGER,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  owner_user_id INTEGER,
  is_current_highest_bidder INTEGER,
  my_user_id INTEGER,
  FOREIGN KEY (focus_id) REFERENCES focus_tasks(id)
);

CREATE TABLE IF NOT EXISTS focus_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  focus_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_hash TEXT,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (focus_id) REFERENCES focus_tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_focus_tasks_status_next_poll_at
ON focus_tasks(status, next_poll_at);

CREATE INDEX IF NOT EXISTS idx_focus_events_focus_created_at
ON focus_events(focus_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_focus_tasks_unique_active_player
ON focus_tasks(player_id)
WHERE status IN ('PENDING', 'ARMED', 'BIDDING');

CREATE TABLE IF NOT EXISTS clause_tasks (
  id TEXT PRIMARY KEY,
  player_query TEXT NOT NULL,
  player_id INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  competition TEXT,
  max_clause_amount INTEGER NOT NULL,
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  stop_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  executed_at INTEGER,
  next_run_at INTEGER NOT NULL,
  lock_token TEXT,
  lock_expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS clause_runtime (
  clause_id TEXT PRIMARY KEY,
  last_seen_clause_amount INTEGER,
  last_seen_owner_user_id INTEGER,
  executed_amount INTEGER,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  FOREIGN KEY (clause_id) REFERENCES clause_tasks(id)
);

CREATE TABLE IF NOT EXISTS clause_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clause_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_hash TEXT,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (clause_id) REFERENCES clause_tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_clause_tasks_status_next_run_at
ON clause_tasks(status, next_run_at);

CREATE INDEX IF NOT EXISTS idx_clause_events_clause_created_at
ON clause_events(clause_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clause_tasks_unique_active_player
ON clause_tasks(player_id)
WHERE status IN ('PENDING', 'EXECUTING');

CREATE TABLE IF NOT EXISTS market_players (
  player_id INTEGER PRIMARY KEY,
  player_name TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  first_seen_price INTEGER,
  last_seen_at INTEGER NOT NULL,
  last_seen_price INTEGER,
  last_until INTEGER,
  highest_bidder_user_id INTEGER,
  was_active_at_last_report INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS market_reports (
  report_date TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_daily_players (
  player_id INTEGER PRIMARY KEY,
  player_name TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  first_seen_price INTEGER,
  prev_seen_price INTEGER,
  last_seen_at INTEGER NOT NULL,
  last_seen_price INTEGER,
  was_active_at_last_report INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_market_players_first_seen_at
ON market_players(first_seen_at);

CREATE INDEX IF NOT EXISTS idx_market_players_last_seen_at
ON market_players(last_seen_at);

CREATE INDEX IF NOT EXISTS idx_market_daily_players_first_seen_at
ON market_daily_players(first_seen_at);

CREATE INDEX IF NOT EXISTS idx_market_daily_players_last_seen_at
ON market_daily_players(last_seen_at);
`;
