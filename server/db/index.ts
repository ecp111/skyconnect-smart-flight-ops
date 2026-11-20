import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type DB = Database.Database;

const here = dirname(fileURLToPath(import.meta.url));

/** Opens the transactional database and applies the schema. Defaults to in-memory. */
export function openDatabase(path = ":memory:"): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(join(here, "schema.sql"), "utf8"));
  return db;
}

/** Run a function inside one ACID transaction (all-or-nothing). */
export function tx<T>(db: DB, fn: () => T): T {
  return db.transaction(fn)();
}
