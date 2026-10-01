-- Horario de trabajo configurable por profesional: patrón semanal recurrente
-- + overrides puntuales por fecha (que ganan por completo sobre el patrón ese
-- día). Reemplaza el rango hardcodeado (09:00–13:00) que hasta ahora vivía en
-- `src/lib/db/slots.ts`. Ver README §7 y CLAUDE.md.

-- Patrón semanal. Varias filas por (provider, weekday) = varias franjas el
-- mismo día (ej. 09-13 y 16-19). Sin filas para un weekday = ese día cerrado.
CREATE TABLE IF NOT EXISTS provider_schedule_rules (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  provider_id     TEXT NOT NULL REFERENCES providers(id),
  weekday         INTEGER NOT NULL,   -- 0=domingo … 6=sábado (Date#getDay())
  start_time      TEXT NOT NULL,      -- 'HH:MM'
  end_time        TEXT NOT NULL,      -- 'HH:MM', > start_time
  CHECK (weekday BETWEEN 0 AND 6),
  CHECK (end_time > start_time)
);
CREATE INDEX IF NOT EXISTS provider_schedule_rules_provider ON provider_schedule_rules (provider_id, weekday);

-- Override puntual por fecha: le gana por completo al patrón semanal para esa
-- fecha (varias franjas ese día, o `closed=1` = no atiende ese día).
CREATE TABLE IF NOT EXISTS provider_schedule_overrides (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  provider_id     TEXT NOT NULL REFERENCES providers(id),
  date            TEXT NOT NULL,      -- 'YYYY-MM-DD'
  start_time      TEXT,               -- NULL cuando closed = 1
  end_time        TEXT,
  closed          INTEGER NOT NULL DEFAULT 0,
  CHECK ((closed = 1 AND start_time IS NULL AND end_time IS NULL) OR (closed = 0 AND end_time > start_time))
);
CREATE INDEX IF NOT EXISTS provider_schedule_overrides_provider_date ON provider_schedule_overrides (provider_id, date);
-- A lo sumo un sentinel "cerrado" por fecha (varias franjas normales sí pueden convivir).
CREATE UNIQUE INDEX IF NOT EXISTS provider_schedule_overrides_closed_unique
  ON provider_schedule_overrides (provider_id, date) WHERE closed = 1;

-- Backfill: preserva el horario hardcodeado actual (Lun-Vie 09:00–13:00) para
-- profesionales ya existentes, para no regresionar nada justo después de migrar.
INSERT INTO provider_schedule_rules (id, organization_id, provider_id, weekday, start_time, end_time)
SELECT 'shr_' || substr(md5(p.id || wd::text), 1, 8), p.organization_id, p.id, wd, '09:00', '13:00'
FROM providers p CROSS JOIN generate_series(1, 5) AS wd
ON CONFLICT DO NOTHING;
