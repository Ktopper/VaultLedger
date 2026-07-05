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

-- Partial unique index: enforces "at most one transaction row per real git
-- commit" while leaving rows with commit_sha IS NULL (there are none today,
-- but nothing depends on that) unconstrained. This is what lets
-- recordTransactionIfNew's ON CONFLICT(commit_sha) DO NOTHING converge two
-- racing reconcile/reindex passes (e.g. \`ledger serve\` + an MCP server both
-- reindexing the same vault) on ONE row for a given commit instead of one of
-- them throwing a UNIQUE-constraint error.
CREATE UNIQUE INDEX IF NOT EXISTS ux_transactions_commit ON transactions(commit_sha) WHERE commit_sha IS NOT NULL;

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
  state TEXT,
  entity TEXT,
  detail TEXT,
  fact_key TEXT,
  pair_lo TEXT,
  pair_hi TEXT,
  resolved_at TEXT
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
  // WAL mode lets readers and a writer proceed concurrently (vs. the default
  // rollback-journal mode, which serializes at the file level) — needed once
  // `ledger serve` and the MCP server can open the same journal file from two
  // processes. ":memory:" databases can't use WAL (no file to write a -wal
  // sidecar next to), so this is skipped for those — existing in-memory tests
  // stay on the default journal mode, unaffected.
  //
  // WAL leaves `-wal`/`-shm` sidecar files beside journal.db. Harmless here:
  // the journal is disposable (rebuilt by reindex/ensureJournal from the vault
  // + git), so an orphaned `-wal` from an unclean shutdown recovers on the
  // next open, and a deleted journal.db just triggers a fresh reindex.
  if (dbPath !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  // busy_timeout makes a writer BLOCK (retrying internally) up to 5s when the
  // db is locked by another connection, instead of throwing SQLITE_BUSY
  // immediately — a second layer of defense alongside the cross-process vault
  // lock (concurrency/lock.ts) for any moment the two aren't perfectly
  // aligned.
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  migrateConflictsTable(db);
  return db;
}

// Columns added to `conflicts` after its original v0.2 shape (memory_a,
// memory_b, kind, created_at, state only). A brand-new journal already gets
// these directly from SCHEMA_SQL's CREATE TABLE, so this migration exists
// purely to UPGRADE a pre-existing journal created against the old shape.
// The old table is empty in every such journal (conflicts didn't exist as a
// feature yet), so a plain ALTER TABLE ADD COLUMN is safe — no backfill
// needed. Migration is driven off `pragma table_info`, so it's idempotent:
// re-running against an already-migrated db (or a fresh one, where CREATE
// TABLE already included these columns) is a no-op. Both paths — fresh open
// and upgraded-from-old-shape — converge on the same full column set plus
// the ux_conflicts_pair_kind_fact unique index.
const CONFLICTS_MIGRATED_COLUMNS: Array<{ name: string; type: string }> = [
  { name: "entity", type: "TEXT" },
  { name: "detail", type: "TEXT" },
  { name: "fact_key", type: "TEXT" },
  { name: "pair_lo", type: "TEXT" },
  { name: "pair_hi", type: "TEXT" },
  { name: "resolved_at", type: "TEXT" },
];

function migrateConflictsTable(db: Database.Database): void {
  const existing = new Set(
    (db.prepare("pragma table_info(conflicts)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const { name, type } of CONFLICTS_MIGRATED_COLUMNS) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE conflicts ADD COLUMN ${name} ${type}`);
    }
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_conflicts_pair_kind_fact ON conflicts(pair_lo, pair_hi, kind, fact_key)`,
  );
}
