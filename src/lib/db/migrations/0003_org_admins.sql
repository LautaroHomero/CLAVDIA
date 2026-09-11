-- Cada organización lleva su lista de administradores explícita (JSON-en-TEXT,
-- misma convención que patients.allergies) en lugar de inferirla del rol.
-- Por defecto es quien crea el consultorio; un admin puede sumar a otros
-- (ver setOrgAdmin en src/lib/db/repo.ts).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS admin_ids TEXT NOT NULL DEFAULT '[]';

-- Backfill: preserva los admins de hoy (memberships.can_admin = 1 — hasta ahora
-- todo founder y toda secretaría se creaban con esa marca) para que nadie
-- pierda acceso administrativo con este cambio.
UPDATE organizations o
SET admin_ids = COALESCE(
  (SELECT json_agg(m.user_id) FROM memberships m WHERE m.organization_id = o.id AND m.can_admin = 1),
  '[]'::json
)::text
WHERE admin_ids = '[]';
