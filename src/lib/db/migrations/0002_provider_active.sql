-- Dar de baja a un profesional: soft-delete, no borrado. `active = false` lo
-- saca de la lista para sacar turnos nuevos (slots libres, ficha del
-- consultorio) sin tocar su historial (turnos, facturas, informes ya
-- generados siguen intactos y con su nombre).
ALTER TABLE providers ADD COLUMN IF NOT EXISTS active INTEGER NOT NULL DEFAULT 1;
