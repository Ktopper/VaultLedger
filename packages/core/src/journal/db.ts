import Database from "better-sqlite3";
import { hashBytes } from "../broker/hash.js";

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
  approval_id TEXT,
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
  state TEXT,
  entity TEXT,
  detail TEXT,
  fact_key TEXT,
  pair_lo TEXT,
  pair_hi TEXT,
  value_hash TEXT NOT NULL DEFAULT '',
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
  dedupeDuplicateCommitShaRows(db);
  createTransactionsCommitShaIndex(db);
  migrateConflictsTable(db);
  migrateConflictsValueHash(db);
  migrateTransactionsTable(db);
  createTransactionsApprovalIndex(db);
  return db;
}

// A pre-v0.3a journal (created before ux_transactions_commit existed) can
// carry two transaction rows that share a non-null commit_sha — e.g. from the
// v0.2 reindex race this index was introduced to close (see
// recordTransactionIfNew's doc comment). Creating a UNIQUE index directly
// against such a journal throws "UNIQUE constraint failed" and the journal
// can never be opened again. The journal is disposable (rebuilt from the
// vault + git by reindex/ensureJournal), so deleting the redundant duplicate
// rows here is safe: keep the oldest (lowest rowid) row per commit_sha and
// drop the rest. MUST run before createTransactionsCommitShaIndex below. A
// no-op (0 rows deleted) on a clean/already-deduped journal, so this is safe
// to run on every open.
function dedupeDuplicateCommitShaRows(db: Database.Database): void {
  db.exec(`
    DELETE FROM transactions WHERE commit_sha IS NOT NULL AND rowid NOT IN (
      SELECT MIN(rowid) FROM transactions WHERE commit_sha IS NOT NULL GROUP BY commit_sha
    );
  `);
}

// Partial unique index: enforces "at most one transaction row per real git
// commit" while leaving rows with commit_sha IS NULL (there are none today,
// but nothing depends on that) unconstrained. This is what lets
// recordTransactionIfNew's ON CONFLICT(commit_sha) DO NOTHING converge two
// racing reconcile/reindex passes (e.g. `ledger serve` + an MCP server both
// reindexing the same vault) on ONE row for a given commit instead of one of
// them throwing a UNIQUE-constraint error. Must run AFTER
// dedupeDuplicateCommitShaRows so an upgraded pre-existing journal with
// duplicate commit_sha rows doesn't crash the CREATE UNIQUE INDEX itself.
function createTransactionsCommitShaIndex(db: Database.Database): void {
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_transactions_commit ON transactions(commit_sha) WHERE commit_sha IS NOT NULL;`,
  );
}

// Columns added to `transactions` after its original shape. A brand-new
// journal already gets these from SCHEMA_SQL's CREATE TABLE; this migration
// exists purely to UPGRADE a pre-existing journal. Driven off `pragma
// table_info` so it's idempotent (re-running against an already-migrated or
// fresh db is a no-op). `approval_id` links an applied transaction to the
// approval whose held operation produced it, so reconcile can SOUNDLY close
// a stale pending approval by exact id-match (see broker/reconcile.ts) rather
// than a path/time heuristic that could false-close an unrelated same-path op.
const TRANSACTIONS_MIGRATED_COLUMNS: Array<{ name: string; type: string }> = [
  { name: "approval_id", type: "TEXT" },
];

// Non-unique partial index backing getAppliedTransactionsByApprovalId's
// lookup (journal.ts): most rows have a NULL approval_id (only applied
// transactions produced by approving a held operation carry one), so the
// index is partial to stay small, and non-unique because one approval can
// legitimately produce multiple transaction rows (e.g. a multi-file apply).
// Must run AFTER migrateTransactionsTable so the column exists on a
// pre-v0.3a journal being upgraded (a fresh journal already has the column
// from SCHEMA_SQL). CREATE INDEX IF NOT EXISTS keeps repeated opens
// idempotent, matching the rest of this file's migration style.
function createTransactionsApprovalIndex(db: Database.Database): void {
  db.exec(
    `CREATE INDEX IF NOT EXISTS ix_transactions_approval ON transactions(approval_id) WHERE approval_id IS NOT NULL;`,
  );
}

function migrateTransactionsTable(db: Database.Database): void {
  const existing = new Set(
    (db.prepare("pragma table_info(transactions)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const { name, type } of TRANSACTIONS_MIGRATED_COLUMNS) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE transactions ADD COLUMN ${name} ${type}`);
    }
  }
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
// and upgraded-from-old-shape — converge on the same full column set; the
// unique index itself is created separately by migrateConflictsValueHash
// below (which also needs to run for these older journals).
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
}

// v0.3a hardening fix: the `conflicts` unique key used to be (pair_lo,
// pair_hi, kind, fact_key) — 4 columns, omitting the conflicting VALUES
// entirely. That meant once a conflict on a given pair+fact was dismissed, a
// LATER contradiction on the same pair+fact but a DIFFERENT value pair
// collided on that same key and was silently dropped by `INSERT ... ON
// CONFLICT DO NOTHING` (Journal.insertConflict) — the new, real
// contradiction never surfaced. Folding a hash of the two conflicting
// values/statements (`value_hash`, computed by
// contradiction/valueHash.ts's conflictValueHash) into the key fixes this:
// each distinct value pair now gets its own row, while re-detecting the
// SAME value pair still collapses to one (both directions, via the
// order-normalized hash).
//
// A brand-new journal already gets the `value_hash` column directly from
// SCHEMA_SQL's CREATE TABLE (NOT NULL; no DEFAULT is required there since
// CREATE TABLE never needs one for a table with no rows yet). This function
// exists purely to UPGRADE a pre-existing journal that predates this column
// (including one created by an EARLIER v0.3a build that already had the old
// 4-column ux_conflicts_pair_kind_fact index).
//
// SQLite's ALTER TABLE ADD COLUMN cannot add a NOT NULL column without also
// supplying a DEFAULT — a structural restriction on ALTER, independent of
// whether the table currently has rows — so the column is added as NOT NULL
// DEFAULT '' and every existing row is then explicitly backfilled in JS
// (SELECT id + detail, hash the detail with hashBytes, UPDATE) BEFORE the
// new unique index is created. Hashing the stored `detail` string verbatim
// (rather than re-parsing the original values back out of it) is robust
// even though `detail`'s format differs between value-conflict and
// negation-conflict rows — it only needs to be a stable, deterministic
// function of "what this conflict is about", not reproduce check.ts's own
// hash exactly.
//
// NOT NULL is load-bearing: SQLite treats NULL as DISTINCT in a UNIQUE
// index, so a NULL value_hash would never dedup against another NULL row
// (every rescan would spawn a fresh duplicate instead of colliding) —
// value_hash must end up NOT NULL, and Journal.insertConflict must never be
// called with a null/undefined one. A stray '' left un-backfilled is the
// SAFE failure direction instead (it would OVER-dedup, colliding with
// another '' row, rather than under-dedup) — which is exactly why the
// backfill runs BEFORE the new unique index exists: nothing can collide
// wrongly against an index that isn't there yet.
//
// Idempotent: driven off `pragma table_info`/`pragma index_list` guards, so
// re-running this against an already-migrated (or fresh) db is a no-op —
// the column already exists, the backfill's `WHERE value_hash = ''` matches
// nothing, and both DROP INDEX IF EXISTS / CREATE UNIQUE INDEX IF NOT
// EXISTS statements are no-ops.
function migrateConflictsValueHash(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("pragma table_info(conflicts)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!columns.has("value_hash")) {
    db.exec(`ALTER TABLE conflicts ADD COLUMN value_hash TEXT NOT NULL DEFAULT ''`);
  }

  const stale = db.prepare(`SELECT id, detail FROM conflicts WHERE value_hash = ''`).all() as Array<{
    id: string;
    detail: string | null;
  }>;
  if (stale.length > 0) {
    const update = db.prepare(`UPDATE conflicts SET value_hash = @value_hash WHERE id = @id`);
    for (const row of stale) {
      const value_hash = hashBytes(Buffer.from(row.detail ?? "", "utf8"));
      update.run({ id: row.id, value_hash });
    }
  }

  // Replace the old 4-column unique key (the root cause of the
  // dismiss-forever bug) with the 5-column one. Must run AFTER the backfill
  // above so no '' placeholder can ever collide wrongly against the new
  // index.
  db.exec(`DROP INDEX IF EXISTS ux_conflicts_pair_kind_fact`);
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_conflicts_pair_kind_fact_value ON conflicts(pair_lo, pair_hi, kind, fact_key, value_hash)`,
  );
}
