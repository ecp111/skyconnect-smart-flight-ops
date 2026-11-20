import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Node's built-in SQLite (no native build step, works on any OS with Node 22.13+).
// It prints a one-time "experimental" warning; silence just that one.
const emit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: any[]) => {
  const msg = typeof warning === "string" ? warning : warning.message;
  if (msg.includes("SQLite is an experimental feature")) return;
  return (emit as any)(warning, ...rest);
}) as typeof process.emitWarning;

const { DatabaseSync } = await import("node:sqlite");

export type DB = InstanceType<typeof DatabaseSync>;

const here = dirname(fileURLToPath(import.meta.url));

/** Opens the transactional database and applies the schema. Defaults to in-memory. */
export function openDatabase(path = ":memory:"): DB {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(readFileSync(join(here, "schema.sql"), "utf8"));
  return db;
}

const depth = new WeakMap<DB, number>();

/**
 * Run a function inside one ACID transaction (all-or-nothing).
 * Nested calls become savepoints, so a service can call another service safely.
 */
export function tx<T>(db: DB, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  const sp = `sp_${level}`;
  db.exec(level === 0 ? "BEGIN" : `SAVEPOINT ${sp}`);
  depth.set(db, level + 1);
  try {
    const out = fn();
    db.exec(level === 0 ? "COMMIT" : `RELEASE ${sp}`);
    return out;
  } catch (e) {
    db.exec(level === 0 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  } finally {
    depth.set(db, level);
  }
}
