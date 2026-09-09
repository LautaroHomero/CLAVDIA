/** DDL applied on every connection (all statements are idempotent). */
export const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS providers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  specialty   TEXT NOT NULL,
  room_label  TEXT NOT NULL,
  default_fee INTEGER NOT NULL DEFAULT 0
);

-- Named practice prices per professional (the default consult uses default_fee).
CREATE TABLE IF NOT EXISTS provider_prices (
  id          TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  label       TEXT NOT NULL,
  amount      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS patients (
  id                TEXT PRIMARY KEY,
  full_name         TEXT NOT NULL,
  dni               TEXT NOT NULL,
  date_of_birth     TEXT NOT NULL,
  phone             TEXT NOT NULL,
  email             TEXT NOT NULL,
  coverage          TEXT NOT NULL,
  allergies         TEXT NOT NULL DEFAULT '[]',
  active_conditions TEXT NOT NULL DEFAULT '[]',
  notes             TEXT
);

CREATE TABLE IF NOT EXISTS medications (
  id              TEXT PRIMARY KEY,
  patient_id      TEXT NOT NULL REFERENCES patients(id),
  name            TEXT NOT NULL,
  dose            TEXT NOT NULL,
  last_prescribed TEXT NOT NULL,
  chronic         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS slots (
  id               TEXT PRIMARY KEY,
  provider_id      TEXT NOT NULL REFERENCES providers(id),
  start            TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  taken            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS appointments (
  id               TEXT PRIMARY KEY,
  patient_id       TEXT NOT NULL REFERENCES patients(id),
  provider_id      TEXT NOT NULL REFERENCES providers(id),
  start            TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  reason           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | completed | cancelled
  price            INTEGER NOT NULL DEFAULT 0,
  created_via      TEXT NOT NULL DEFAULT 'front-desk'
);

-- Stored end-of-day summaries. provider_id = '' means the clinic-wide report.
CREATE TABLE IF NOT EXISTS daily_reports (
  date         TEXT NOT NULL,
  provider_id  TEXT NOT NULL DEFAULT '',
  generated_at TEXT NOT NULL,
  generated_by TEXT,
  payload      TEXT NOT NULL,
  PRIMARY KEY (date, provider_id)
);

CREATE TABLE IF NOT EXISTS invoices (
  id         TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  date       TEXT NOT NULL,
  concept    TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'unpaid'
);

CREATE TABLE IF NOT EXISTS lab_results (
  id         TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  date       TEXT NOT NULL,
  panel      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending-review',
  summary    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prescription_requests (
  id           TEXT PRIMARY KEY,
  patient_id   TEXT NOT NULL REFERENCES patients(id),
  medication   TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  status       TEXT NOT NULL,
  decided_by   TEXT,
  note         TEXT
);

CREATE TABLE IF NOT EXISTS patient_messages (
  id         TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  body       TEXT NOT NULL,
  sent_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL,
  pin_hash    TEXT NOT NULL,
  pin_salt    TEXT NOT NULL,
  patient_id  TEXT REFERENCES patients(id),
  provider_id TEXT REFERENCES providers(id)
);

-- One login per name (case-insensitive) so typed-name login is unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS users_name_unique ON users (lower(trim(name)));

-- Human-in-the-loop requests the workflow is blocked on. Shared source of truth
-- for the web UI panel and the Slack integration (fixes cross-process state).
CREATE TABLE IF NOT EXISTS pending_requests (
  token         TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  kind          TEXT NOT NULL,
  action        TEXT NOT NULL,
  summary       TEXT NOT NULL,
  details       TEXT,
  risk_level    TEXT,
  patient_name  TEXT,
  question      TEXT,
  requested_by  TEXT,
  created_at    TEXT NOT NULL,
  channels      TEXT NOT NULL DEFAULT '[]',
  slack_channel TEXT,
  slack_ts      TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  resolved_by   TEXT,
  resolved_at   TEXT,
  response      TEXT
);
`;
