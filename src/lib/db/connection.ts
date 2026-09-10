import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "./migrate";
import { SCHEMA } from "./schema";
import { seedIfEmpty } from "./seed";

/**
 * Local SQLite database (file at `data/clinic.db`, gitignored).
 *
 * The file **persists** across `npm run dev` restarts: `SCHEMA` is all
 * `IF NOT EXISTS`, `migrate()` adds any new columns/indexes in place, and
 * `seedIfEmpty()` only seeds an empty DB. Delete `data/` only to start over.
 *
 * `getDb()` is only ever called from `"use step"` functions and API route
 * handlers — never from workflow-context code — so Node built-ins are allowed.
 * The connection is cached on `globalThis` to survive dev hot-reload.
 */
const globalForDb = globalThis as unknown as {
  __clinicDb?: Database.Database;
  __clinicSchema?: string;
};

export function getDb(): Database.Database {
  const cached = globalForDb.__clinicDb;
  if (cached) {
    // The connection survives dev hot-reload; re-apply the DDL when the schema
    // string itself changed so new tables/columns/indexes reach a long-running
    // process without a restart. Every statement is idempotent, so this is cheap.
    if (globalForDb.__clinicSchema !== SCHEMA) {
      cached.exec(SCHEMA);
      migrate(cached);
      globalForDb.__clinicSchema = SCHEMA;
    }
    return cached;
  }

  const dir = join(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });

  const db = new Database(join(dir, "clinic.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  seedIfEmpty(db);

  globalForDb.__clinicDb = db;
  globalForDb.__clinicSchema = SCHEMA;
  return db;
}
