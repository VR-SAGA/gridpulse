-- Probe results are rolled up into time buckets instead of stored raw.
-- 5-minute buckets (kept 7 days) serve the 5m-6h alert windows; hourly
-- buckets (kept 35 days) serve the 3-day window and the 28-day budget.
-- This keeps every SLO evaluation under ~1,000 row reads, well inside the
-- D1 Free plan limits.
CREATE TABLE buckets (
  target      TEXT    NOT NULL,
  resolution  INTEGER NOT NULL,          -- bucket size in seconds: 300 or 3600
  start_ts    INTEGER NOT NULL,          -- unix seconds, aligned to resolution
  total       INTEGER NOT NULL DEFAULT 0,
  ok          INTEGER NOT NULL DEFAULT 0, -- non-5xx, no timeout
  fast        INTEGER NOT NULL DEFAULT 0, -- ok AND under the latency threshold
  latency_sum INTEGER NOT NULL DEFAULT 0, -- ms, for the average shown on the page
  PRIMARY KEY (target, resolution, start_ts)
);

-- Latest probe per target, for the status page.
CREATE TABLE last_probe (
  target     TEXT PRIMARY KEY,
  ts         INTEGER NOT NULL,
  status     INTEGER NOT NULL,           -- HTTP status, 0 on network error or timeout
  latency_ms INTEGER NOT NULL,
  ok         INTEGER NOT NULL,
  error      TEXT
);

-- One open incident per SLO at most. Closed incidents are deleted here;
-- their history lives in GitHub Issues.
CREATE TABLE incidents (
  slo_id       TEXT PRIMARY KEY,
  issue_number INTEGER,
  severity     TEXT NOT NULL,
  rule         TEXT NOT NULL,
  opened_ts    INTEGER NOT NULL,
  updated_ts   INTEGER NOT NULL
);

-- Latest evaluation per SLO, so the status page is a single cheap read.
CREATE TABLE slo_status (
  slo_id           TEXT PRIMARY KEY,
  ts               INTEGER NOT NULL,
  json             TEXT NOT NULL
);
