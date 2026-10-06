-- Stock de insumos por consultorio, por lote (casi todo vence). Ver src/lib/domain/stock.ts.
--  · stock_items:     el producto (guantes, jeringas…) y su umbral de stock bajo.
--  · stock_lots:      cada ingreso; `expires_on` es opcional (YYYY-MM-DD, NULL = no vence).
--  · stock_movements: libro de movimientos (ingreso / uso / vencimiento / pérdida / ajuste);
--                     la cantidad de un lote solo cambia junto con un movimiento.

CREATE TABLE IF NOT EXISTS stock_items (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name            TEXT NOT NULL,
  unit            TEXT NOT NULL DEFAULT 'unidad',
  category        TEXT NOT NULL DEFAULT '',
  min_quantity    INTEGER NOT NULL DEFAULT 0,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS stock_items_org ON stock_items (organization_id, active);

CREATE TABLE IF NOT EXISTS stock_lots (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id),
  item_id          TEXT NOT NULL REFERENCES stock_items(id),
  lot_code         TEXT NOT NULL DEFAULT '',
  quantity         INTEGER NOT NULL CHECK (quantity >= 0),
  initial_quantity INTEGER NOT NULL,
  expires_on       TEXT,
  received_at      TEXT NOT NULL,
  created_by       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS stock_lots_item ON stock_lots (item_id, expires_on);

CREATE TABLE IF NOT EXISTS stock_movements (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  item_id         TEXT NOT NULL REFERENCES stock_items(id),
  lot_id          TEXT REFERENCES stock_lots(id),
  delta           INTEGER NOT NULL,                -- + ingreso, − baja/uso
  reason          TEXT NOT NULL,                   -- ingreso | uso | vencimiento | perdida | ajuste
  note            TEXT NOT NULL DEFAULT '',
  actor_id        TEXT NOT NULL,
  actor_name      TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'manual',  -- manual | agent
  appointment_id  TEXT REFERENCES appointments(id),
  consultation_id TEXT REFERENCES consultations(id),
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS stock_movements_item ON stock_movements (item_id, created_at);
CREATE INDEX IF NOT EXISTS stock_movements_org ON stock_movements (organization_id, created_at);

-- Quién puede cargar / dar de baja stock (lo decide el admin del consultorio; todo el
-- staff puede ver) y con cuántos días de anticipación se avisa que algo vence.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stock_roles TEXT NOT NULL DEFAULT '["medico","recepcion"]';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stock_expiry_days INTEGER NOT NULL DEFAULT 30;
