-- CLAVDIA — initial Postgres schema.
-- Translated from the SQLite `SCHEMA` + `migrate.ts` additive columns.
-- Tables are ordered so every REFERENCES target already exists (Postgres is
-- strict about forward references; SQLite was not). Booleans stay as INTEGER
-- 0/1 to keep the row mappers unchanged. Timestamps / JSON stay as TEXT
-- (ISO-8601 strings sort lexicographically; JSON is (de)serialised in JS).

-- ── Multi-tenant core ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL,
  address    TEXT NOT NULL DEFAULT '',
  city       TEXT NOT NULL DEFAULT '',
  hours      TEXT NOT NULL DEFAULT 'Lunes a viernes de 8 a 18 h',
  phone      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_unique ON organizations (slug);

-- ── Global (per-person) records ────────────────────────────────────────────
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

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL DEFAULT '',   -- login identifier for every role
  dni        TEXT NOT NULL DEFAULT '',   -- identity anchor: staff dedup + login + PIN recovery
  phone      TEXT NOT NULL DEFAULT '',   -- for PIN recovery over WhatsApp
  role       TEXT NOT NULL,              -- medico | recepcion | paciente
  pin_hash   TEXT NOT NULL,              -- '' until the person sets a PIN via recovery
  pin_salt   TEXT NOT NULL,
  patient_id TEXT REFERENCES patients(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS users_name_unique ON users (lower(trim(name)));
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
  ON users (lower(trim(email))) WHERE trim(email) <> '';
CREATE UNIQUE INDEX IF NOT EXISTS users_dni_unique
  ON users (replace(replace(trim(dni), '.', ''), ' ', '')) WHERE trim(dni) <> '';

CREATE TABLE IF NOT EXISTS medications (
  id              TEXT PRIMARY KEY,
  patient_id      TEXT NOT NULL REFERENCES patients(id),
  name            TEXT NOT NULL,
  dose            TEXT NOT NULL,
  last_prescribed TEXT NOT NULL,
  chronic         INTEGER NOT NULL DEFAULT 0
);

-- ── Per-organization records ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS providers (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name            TEXT NOT NULL,
  specialty       TEXT NOT NULL,
  room_label      TEXT NOT NULL,
  default_fee     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id         TEXT NOT NULL REFERENCES users(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  role            TEXT NOT NULL,        -- medico | recepcion
  provider_id     TEXT REFERENCES providers(id),
  can_admin       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, organization_id)
);

CREATE TABLE IF NOT EXISTS patient_organizations (
  patient_id      TEXT NOT NULL REFERENCES patients(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  joined_at       TEXT NOT NULL,
  PRIMARY KEY (patient_id, organization_id)
);

CREATE TABLE IF NOT EXISTS provider_prices (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  provider_id     TEXT NOT NULL REFERENCES providers(id),
  label           TEXT NOT NULL,
  amount          INTEGER NOT NULL
);

-- Per-professional policy for MANUAL appointment changes (set by the médico).
CREATE TABLE IF NOT EXISTS provider_settings (
  provider_id        TEXT PRIMARY KEY REFERENCES providers(id),
  who_can_change     TEXT NOT NULL DEFAULT 'anyone',   -- anyone | staff_only
  late_change_policy TEXT NOT NULL DEFAULT 'direct'    -- direct | needs_approval
);

CREATE TABLE IF NOT EXISTS slots (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id),
  provider_id      TEXT NOT NULL REFERENCES providers(id),
  start            TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  taken            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS appointments (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id),
  patient_id       TEXT NOT NULL REFERENCES patients(id),
  provider_id      TEXT NOT NULL REFERENCES providers(id),
  start            TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  reason           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | in-progress | completed | cancelled
  price            INTEGER NOT NULL DEFAULT 0,
  actual_start     TEXT,
  actual_end       TEXT,
  created_via      TEXT NOT NULL DEFAULT 'front-desk'
);

CREATE TABLE IF NOT EXISTS invoices (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  patient_id      TEXT NOT NULL REFERENCES patients(id),
  date            TEXT NOT NULL,
  concept         TEXT NOT NULL,
  amount          INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'unpaid'
);

CREATE TABLE IF NOT EXISTS lab_results (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  patient_id      TEXT NOT NULL REFERENCES patients(id),
  date            TEXT NOT NULL,
  panel           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending-review',
  summary         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prescription_requests (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  patient_id      TEXT NOT NULL REFERENCES patients(id),
  medication      TEXT NOT NULL,
  requested_at    TEXT NOT NULL,
  status          TEXT NOT NULL,
  decided_by      TEXT,
  note            TEXT
);

CREATE TABLE IF NOT EXISTS patient_messages (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  patient_id      TEXT NOT NULL REFERENCES patients(id),
  body            TEXT NOT NULL,
  sent_at         TEXT NOT NULL
);

-- Simulated "now" per professional per day.
CREATE TABLE IF NOT EXISTS clinic_state (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  date            TEXT NOT NULL,
  provider_id     TEXT NOT NULL,
  clock           TEXT NOT NULL,
  PRIMARY KEY (date, provider_id)
);

-- Delay / move-up notices pushed to a patient's chat.
CREATE TABLE IF NOT EXISTS patient_notices (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  appointment_id  TEXT NOT NULL REFERENCES appointments(id),
  patient_id      TEXT NOT NULL REFERENCES patients(id),
  date            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  message         TEXT NOT NULL,
  resolved        INTEGER NOT NULL DEFAULT 0
);

-- Manual appointment changes a patient asked for that need staff sign-off.
CREATE TABLE IF NOT EXISTS appointment_change_requests (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  appointment_id  TEXT NOT NULL REFERENCES appointments(id),
  provider_id     TEXT NOT NULL REFERENCES providers(id),
  patient_id      TEXT NOT NULL REFERENCES patients(id),
  kind            TEXT NOT NULL,                    -- cancel | reschedule
  new_slot_id     TEXT,
  reason          TEXT,
  requested_by    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  decided_by      TEXT,
  decided_at      TEXT
);

-- Stored end-of-day summaries. provider_id = '' means the org-wide report.
CREATE TABLE IF NOT EXISTS daily_reports (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  date            TEXT NOT NULL,
  provider_id     TEXT NOT NULL DEFAULT '',
  generated_at    TEXT NOT NULL,
  generated_by    TEXT,
  payload         TEXT NOT NULL,
  PRIMARY KEY (organization_id, date, provider_id)
);

-- Human-in-the-loop requests the workflow is blocked on.
CREATE TABLE IF NOT EXISTS pending_requests (
  token           TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  run_id          TEXT NOT NULL,
  kind            TEXT NOT NULL,
  action          TEXT NOT NULL,
  summary         TEXT NOT NULL,
  details         TEXT,
  risk_level      TEXT,
  patient_name    TEXT,
  question        TEXT,
  requested_by    TEXT,
  created_at      TEXT NOT NULL,
  channels        TEXT NOT NULL DEFAULT '[]',
  slack_channel   TEXT,
  slack_ts        TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  resolved_by     TEXT,
  resolved_at     TEXT,
  response        TEXT
);

-- One-time codes for patient PIN recovery. Stored only as a salted hash.
CREATE TABLE IF NOT EXISTS pin_reset_codes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  code_hash   TEXT NOT NULL,
  code_salt   TEXT NOT NULL,
  channel     TEXT NOT NULL,               -- email | whatsapp
  sent_to     TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS pin_reset_codes_user ON pin_reset_codes (user_id, created_at);
