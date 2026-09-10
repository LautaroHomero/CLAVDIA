/** DDL applied on every connection (all statements are idempotent). */
export const SCHEMA = /* sql */ `
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

CREATE TABLE IF NOT EXISTS users (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  email    TEXT NOT NULL DEFAULT '',    -- login identifier for every role
  role     TEXT NOT NULL,               -- medico | recepcion | paciente
  pin_hash TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  patient_id TEXT REFERENCES patients(id)  -- only for role = paciente
);
CREATE UNIQUE INDEX IF NOT EXISTS users_name_unique ON users (lower(trim(name)));
-- users_email_unique is created in migrate.ts (it references a column that older
-- databases don't have yet, so it can't live in this always-applied block).

-- A staff user's link to an organization (a professional can be in several).
CREATE TABLE IF NOT EXISTS memberships (
  user_id         TEXT NOT NULL REFERENCES users(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  role            TEXT NOT NULL,        -- medico | recepcion
  provider_id     TEXT REFERENCES providers(id),  -- for medico: their provider record in that org
  can_admin       INTEGER NOT NULL DEFAULT 0,     -- may onboard professionals / manage the org
  PRIMARY KEY (user_id, organization_id)
);

-- A patient's link to an organization (they can be treated at several).
CREATE TABLE IF NOT EXISTS patient_organizations (
  patient_id      TEXT NOT NULL REFERENCES patients(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  joined_at       TEXT NOT NULL,
  PRIMARY KEY (patient_id, organization_id)
);

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

-- Manual appointment changes a patient asked for that need staff sign-off
-- (only created when the provider's late_change_policy = 'needs_approval').
CREATE TABLE IF NOT EXISTS appointment_change_requests (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  appointment_id  TEXT NOT NULL REFERENCES appointments(id),
  provider_id     TEXT NOT NULL REFERENCES providers(id),
  patient_id      TEXT NOT NULL REFERENCES patients(id),
  kind            TEXT NOT NULL,                    -- cancel | reschedule
  new_slot_id     TEXT,                             -- reschedule only
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
`;
