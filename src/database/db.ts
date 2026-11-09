import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { logger } from "../utils/logger.js";

export type Db = DatabaseSync;

const DB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Opens (creating if needed) the SQLite database, applies pragmas and migrations.
 * - schema.sql holds the canonical DDL and is fully idempotent (IF NOT EXISTS),
 *   so we execute it on every boot.
 * - Optional incremental migrations live in this folder as NNNN_name.sql and
 *   run exactly once, tracked in _migrations.
 */
export function openDatabase(databasePath: string): Db {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);

  db.exec(`PRAGMA journal_mode = WAL;`);
  db.exec(`PRAGMA foreign_keys = ON;`);
  db.exec(`PRAGMA busy_timeout = 5000;`);
  db.exec(`PRAGMA synchronous = NORMAL;`);

  // Fresh installs create the _migrations table first so tracking works below.
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );`);

  const schemaPath = path.join(DB_DIR, "schema.sql");
  db.exec(fs.readFileSync(schemaPath, "utf8"));

  const applied = new Set(
    (db.prepare(`SELECT name FROM _migrations`).all() as { name: string }[]).map((r) => r.name)
  );
  const migrationFiles = fs
    .readdirSync(DB_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

  for (const file of migrationFiles) {
    if (applied.has(file)) continue;
    logger.info({ migration: file }, "applying migration");
    db.exec(fs.readFileSync(path.join(DB_DIR, file), "utf8"));
    db.prepare(`INSERT OR IGNORE INTO _migrations (name) VALUES (?)`).run(file);
  }

  return db;
}

/** Startup reaper: this process is the only live server, so pre-boot 'running'/'active' state is stale. */
export function reapStaleState(db: Db): void {
  const now = new Date().toISOString();
  const sessions = db.prepare(`UPDATE sessions SET status='orphaned', ended_at=? WHERE status='active'`).run(now);
  const processes = db.prepare(`UPDATE processes SET status='failed', ended_at=? WHERE status='running'`).run(now);
  const locks = db.prepare(`DELETE FROM file_locks WHERE expires_at < ?`).run(now);
  if (sessions.changes > 0 || processes.changes > 0 || locks.changes > 0) {
    logger.info(
      { orphanedSessions: sessions.changes, failedProcesses: processes.changes, expiredLocks: locks.changes },
      "startup reaper applied"
    );
  }
}

/** Prune audit events older than retentionDays. */
export function pruneEvents(db: Db, retentionDays: number): number {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare(`DELETE FROM events WHERE created_at < ?`).run(cutoff);
  return Number(result.changes);
}
