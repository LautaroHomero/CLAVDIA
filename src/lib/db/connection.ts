import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA } from "./schema";
import { seedIfEmpty } from "./seed";

/**
 * Local SQLite database (file at `data/clinic.db`, gitignored).
 *
 * `getDb()` is only ever called from `"use step"` functions and API route
 * handlers — never from workflow-context code — so Node built-ins are allowed.
 * The connection is cached on `globalThis` to survive dev hot-reload.
 */
const globalForDb = globalThis as unknown as { __clinicDb?: Database.Database };

export function getDb(): Database.Database {
  if (globalForDb.__clinicDb) return globalForDb.__clinicDb;

  const dir = join(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });

  const db = new Database(join(dir, "clinic.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  seedIfEmpty(db);

  globalForDb.__clinicDb = db;
  return db;
}
