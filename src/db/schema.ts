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
`;
