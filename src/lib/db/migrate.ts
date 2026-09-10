import type { Database } from "better-sqlite3";

/**
 * Forward-only, additive migrations so the local database (`data/clinic.db`)
 * survives schema edits **without a wipe**. `CREATE TABLE IF NOT EXISTS` in
 * `SCHEMA` never alters an existing table, so a new column would otherwise only
 * appear after `rm -rf data`. This runs right after `SCHEMA` on every fresh
 * connection and only ever *adds* things (columns with a default, indexes).
 *
 * To add a column: put it in the `CREATE TABLE` in `schema.ts` (for fresh DBs)
 * **and** add a line here (for existing DBs). To drop/rename a column you still
 * need a real migration or a wipe — that's intentional.
 */

/** `[table, column, column-definition]` — added when the column is missing. */
const ADDITIVE_COLUMNS: ReadonlyArray<readonly [string, string, string]> = [
  ["organizations", "city", "TEXT NOT NULL DEFAULT ''"],
  ["users", "email", "TEXT NOT NULL DEFAULT ''"],
  ["memberships", "can_admin", "INTEGER NOT NULL DEFAULT 0"],
];

/**
 * Statements that reference columns added above. They live here (not in
 * `SCHEMA`) because running them against a DB that predates the column would
 * throw; by the time we get here the columns exist. All are `IF NOT EXISTS`.
 */
const POST_COLUMN_SQL: readonly string[] = [
  `CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(trim(email))) WHERE trim(email) <> ''`,
];

function tableExists(db: Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function columnNames(db: Database, table: string): Set<string> {
  // `table` values here are hard-coded constants, never user input.
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

export function migrate(db: Database): void {
  for (const [table, column, definition] of ADDITIVE_COLUMNS) {
    if (!tableExists(db, table)) continue;
    if (!columnNames(db, table).has(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
  for (const sql of POST_COLUMN_SQL) db.exec(sql);
}
