import postgres from "postgres";

/**
 * Postgres connection (Supabase). One pooled client per process, cached on
 * `globalThis` so it survives dev hot-reload.
 *
 * - `DATABASE_URL` is the **pooled** connection string (Supabase transaction
 *   pooler, port 6543). `prepare: false` is required for that pooler.
 * - Schema lives out-of-band: `npm run db:migrate` (see `scripts/migrate.mts`),
 *   never on the request path. There is no local seed — every environment
 *   (dev/test/prod) is a real Supabase project; its data lives there, not in
 *   this repo.
 */
export type Sql = ReturnType<typeof postgres>;

const globalForDb = globalThis as unknown as { __sql?: Sql };

export function getSql(): Sql {
  if (globalForDb.__sql) return globalForDb.__sql;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL no está configurada. Copiá la connection string (pooled) de Supabase a .env.local — ver .env.example.",
    );
  }

  globalForDb.__sql = postgres(url, {
    prepare: false,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idle_timeout: 20,
    connection: { application_name: "clavdia" },
    // Supabase requires TLS; the URL's own `sslmode` (if any) still wins since
    // postgres.js reads it from the query string and overrides this default.
    ssl: "require",
  });
  return globalForDb.__sql;
}
