import Database from "better-sqlite3";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  op TEXT NOT NULL,
  path TEXT NOT NULL,
  hash_before TEXT,
  hash_after TEXT,
  session TEXT NOT NULL,
  reason TEXT,
  memory_id TEXT,
  commit_sha TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  entity TEXT,
  status TEXT NOT NULL,
  confidence TEXT,
  created TEXT NOT NULL,
  source TEXT,
  supersedes TEXT,
  expires TEXT,
  last_referenced TEXT
);

CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id TEXT,
  tag TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_tags_memory_id ON memory_tags (memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags (tag);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  held_operation TEXT NOT NULL,
  zone TEXT NOT NULL,
  reason TEXT,
  session TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  memory_a TEXT,
  memory_b TEXT,
  kind TEXT,
  created_at TEXT,
  state TEXT
);
`;

/**
 * Open (and if needed, initialize) the VaultLedger journal database.
 * Pass ":memory:" for an ephemeral in-memory database (used in tests).
 * DDL uses CREATE TABLE/INDEX IF NOT EXISTS, so calling this repeatedly
 * against the same file (or schema) is idempotent.
 *
 * Ownership: the caller owns the returned Database handle's lifecycle and is
 * responsible for calling `db.close()` when done (e.g. on process shutdown).
 */
export function openJournal(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  return db;
}
