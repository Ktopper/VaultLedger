import type Database from "better-sqlite3";

export type TransactionStatus = "applied" | "reverted";
export type ApprovalState = "pending" | "approved" | "rejected" | "stale";

export interface TransactionRow {
  id: string;
  op: string;
  path: string;
  hash_before: string | null;
  hash_after: string | null;
  session: string;
  reason: string | null;
  memory_id: string | null;
  commit_sha: string | null;
  /** The approval whose held operation produced this transaction, when it was
   * applied via `Approvals.approve`. Null for direct broker writes (which
   * never pass through an approval). Lets reconcile SOUNDLY close a stale
   * pending approval by exact id-match (see broker/reconcile.ts) instead of a
   * path/time heuristic that could false-close an unrelated same-path op. */
  approval_id: string | null;
  created_at: string;
  status: TransactionStatus;
}

export interface MemoryRow {
  id: string;
  path: string;
  entity: string | null;
  status: string;
  confidence: string | null;
  created: string;
  source: string | null;
  supersedes: string | null;
  expires: string | null;
  last_referenced: string | null;
}

export interface ApprovalRow {
  id: string;
  held_operation: string;
  zone: string;
  reason: string | null;
  session: string;
  state: ApprovalState;
  created_at: string;
  resolved_at: string | null;
}

export interface ConflictRow {
  id: string;
  memory_a: string | null;
  memory_b: string | null;
  pair_lo: string | null;
  pair_hi: string | null;
  kind: string | null;
  fact_key: string | null;
  entity: string | null;
  detail: string | null;
  /**
   * Deterministic hash of the two conflicting values/statements (see
   * `contradiction/valueHash.ts`'s `conflictValueHash`), folded into the
   * `conflicts` table's unique dedup key alongside (pair_lo, pair_hi, kind,
   * fact_key). MUST be non-null/non-empty on every insert -- SQLite treats
   * NULL as DISTINCT in a UNIQUE index, so a null value_hash would never
   * dedup against another null (every rescan would spawn a fresh duplicate
   * row instead of colliding), permanently defeating the dedup this column
   * exists to provide.
   */
  value_hash: string;
  created_at: string | null;
  state: string | null;
  resolved_at: string | null;
}

export interface MemoryRelationRow {
  /** The distillation memory that cites `source_id`. */
  memory_id: string;
  /** The source memory `memory_id` was distilled from. */
  source_id: string;
  /** Relation kind — "distilled" is the only kind v0.3b writes; the column
   * is free text (like other kind columns in this file) so a later relation
   * kind doesn't require a schema migration. */
  kind: string;
}

export interface ListTransactionsFilters {
  limit?: number;
  entity?: string;
  session?: string;
}

export interface QueryMemoriesFilters {
  entity?: string;
  tag?: string;
  status?: string;
  since?: string;
  limit?: number;
}

const DEFAULT_QUERY_LIMIT = 100;

/**
 * Typed, parameterized access to the VaultLedger SQLite journal. No SQL
 * string interpolation of caller-provided values — everything goes through
 * bound parameters. The (small, fixed) set of column names used in dynamic
 * UPDATE/SELECT clauses is whitelisted in this file, never taken from
 * caller input.
 */
export class Journal {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Run several Journal calls as a single atomic SQLite transaction (used by
   * undo's journal compensation: mark the original transaction reverted,
   * mark its memory reverted, and insert the new revert-transaction row all
   * together, so a crash mid-sequence can't leave the journal half-updated).
   */
  runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---------------------------------------------------------------------
  // Transactions
  // ---------------------------------------------------------------------

  recordTransaction(row: TransactionRow): void {
    this.db
      .prepare(
        `INSERT INTO transactions
           (id, op, path, hash_before, hash_after, session, reason, memory_id, commit_sha, approval_id, created_at, status)
         VALUES (@id, @op, @path, @hash_before, @hash_after, @session, @reason, @memory_id, @commit_sha, @approval_id, @created_at, @status)`,
      )
      .run(row);
  }

  /**
   * Same shape as `recordTransaction`, but tolerates a duplicate `commit_sha`
   * instead of throwing (`ON CONFLICT(commit_sha) ... DO NOTHING` against the
   * partial `ux_transactions_commit` unique index — the `WHERE commit_sha IS
   * NOT NULL` on the ON CONFLICT clause must mirror the index's own partial
   * predicate; SQLite requires the two to match for the upsert target to
   * resolve). Used by `reconcile`/`reindex`'s crash-recovery repair path,
   * where two processes can race to repair the SAME missing commit (e.g.
   * `ledger serve` and an MCP server both reindexing on startup) — both
   * decide the row is missing, but only one insert should land. The normal
   * broker write path keeps using `recordTransaction`: its `commit_sha` is
   * always freshly minted by that same call, never a potential duplicate, so
   * a real integrity violation there should still throw rather than be
   * silently swallowed. Returns whether a new row was actually inserted.
   */
  recordTransactionIfNew(row: TransactionRow): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO transactions
           (id, op, path, hash_before, hash_after, session, reason, memory_id, commit_sha, approval_id, created_at, status)
         VALUES (@id, @op, @path, @hash_before, @hash_after, @session, @reason, @memory_id, @commit_sha, @approval_id, @created_at, @status)
         ON CONFLICT(commit_sha) WHERE commit_sha IS NOT NULL DO NOTHING`,
      )
      .run(row);
    return result.changes > 0;
  }

  /**
   * Applied transactions produced by approving the given approval — the sound
   * link reconcile uses to close a stale pending approval (design §5,
   * approve->apply crash gap). Filtered in SQL by `approval_id` (an indexed
   * lookup against the partial `ix_transactions_approval` index — see db.ts —
   * not an unbounded full-table scan per pending approval) and by
   * `status='applied'` so a later-reverted apply doesn't count as
   * still-applied.
   */
  getAppliedTransactionsByApprovalId(approvalId: string): TransactionRow[] {
    return this.db
      .prepare<{ approvalId: string }, TransactionRow>(
        `SELECT * FROM transactions WHERE approval_id = @approvalId AND status = 'applied'`,
      )
      .all({ approvalId });
  }

  getTransaction(id: string): TransactionRow | null {
    const row = this.db
      .prepare<{ id: string }, TransactionRow>(`SELECT * FROM transactions WHERE id = @id`)
      .get({ id });
    return row ?? null;
  }

  setTransactionStatus(id: string, status: TransactionStatus): void {
    this.db.prepare(`UPDATE transactions SET status = @status WHERE id = @id`).run({ id, status });
  }

  /**
   * Link a transaction to a memory row after the fact. The broker records
   * transactions with memory_id=null (it operates on paths, not memory ids);
   * the memory store calls this once it has both the txnId and the memory id
   * so undo can reach the memory row (mark it 'reverted') and
   * listTransactions({entity}) can join on memory_id.
   */
  setTransactionMemoryId(txnId: string, memoryId: string): void {
    this.db
      .prepare(`UPDATE transactions SET memory_id = @memoryId WHERE id = @txnId`)
      .run({ txnId, memoryId });
  }

  listTransactions(filters: ListTransactionsFilters): TransactionRow[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    let joinMemories = false;

    if (filters.entity !== undefined) {
      joinMemories = true;
      conditions.push("m.entity = @entity");
      params.entity = filters.entity;
    }
    if (filters.session !== undefined) {
      conditions.push("t.session = @session");
      params.session = filters.session;
    }

    const join = joinMemories ? "LEFT JOIN memories m ON m.id = t.memory_id" : "";
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = filters.limit !== undefined ? "LIMIT @limit" : "";
    if (filters.limit !== undefined) {
      params.limit = filters.limit;
    }

    const sql = `
      SELECT t.* FROM transactions t
      ${join}
      ${where}
      ORDER BY t.created_at DESC, t.rowid DESC
      ${limitClause}
    `;

    return this.db.prepare<Record<string, unknown>, TransactionRow>(sql).all(params);
  }

  hasCommit(sha: string): boolean {
    const row = this.db
      .prepare<{ sha: string }, { one: number }>(
        `SELECT 1 as one FROM transactions WHERE commit_sha = @sha LIMIT 1`,
      )
      .get({ sha });
    return row !== undefined;
  }

  // ---------------------------------------------------------------------
  // Memories
  // ---------------------------------------------------------------------

  insertMemory(row: MemoryRow): void {
    this.db
      .prepare(
        `INSERT INTO memories
           (id, path, entity, status, confidence, created, source, supersedes, expires, last_referenced)
         VALUES (@id, @path, @entity, @status, @confidence, @created, @source, @supersedes, @expires, @last_referenced)`,
      )
      .run(row);
  }

  getMemory(id: string): MemoryRow | null {
    const row = this.db
      .prepare<{ id: string }, MemoryRow>(`SELECT * FROM memories WHERE id = @id`)
      .get({ id });
    return row ?? null;
  }

  setMemoryStatus(id: string, status: string): void {
    this.db.prepare(`UPDATE memories SET status = @status WHERE id = @id`).run({ id, status });
  }

  updateMemory(id: string, patch: Partial<Omit<MemoryRow, "id">>): void {
    const allowedColumns: Array<keyof Omit<MemoryRow, "id">> = [
      "path",
      "entity",
      "status",
      "confidence",
      "created",
      "source",
      "supersedes",
      "expires",
      "last_referenced",
    ];
    const columns = allowedColumns.filter((c) => c in patch);
    if (columns.length === 0) return;

    const setClause = columns.map((c) => `${c} = @${c}`).join(", ");
    const params: Record<string, unknown> = { id, ...patch };
    this.db.prepare(`UPDATE memories SET ${setClause} WHERE id = @id`).run(params);
  }

  queryMemories(filters: QueryMemoriesFilters): MemoryRow[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    let joinTags = false;

    if (filters.entity !== undefined) {
      conditions.push("m.entity = @entity");
      params.entity = filters.entity;
    }
    if (filters.status !== undefined) {
      conditions.push("m.status = @status");
      params.status = filters.status;
    }
    if (filters.since !== undefined) {
      conditions.push("m.created >= @since");
      params.since = filters.since;
    }
    if (filters.tag !== undefined) {
      joinTags = true;
      conditions.push("mt.tag = @tag");
      params.tag = filters.tag;
    }

    const join = joinTags ? "JOIN memory_tags mt ON mt.memory_id = m.id" : "";
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filters.limit ?? DEFAULT_QUERY_LIMIT;
    params.limit = limit;

    const sql = `
      SELECT DISTINCT m.* FROM memories m
      ${join}
      ${where}
      ORDER BY m.created DESC
      LIMIT @limit
    `;

    return this.db.prepare<Record<string, unknown>, MemoryRow>(sql).all(params);
  }

  /**
   * Same-entity lookup with SQL-side case + surrounding-whitespace folding
   * (`lower(trim(entity)) = @folded`). Callers pass an already-folded key
   * (see `foldEntity`) and should still JS-refilter to collapse *internal*
   * whitespace, which SQL trim() does not. Used by the contradiction entity
   * matcher, which must treat "Nova"/"nova"/" nova " as one entity.
   */
  queryMemoriesByEntityFolded(folded: string, limit: number): MemoryRow[] {
    const sql = `
      SELECT m.* FROM memories m
      WHERE lower(trim(m.entity)) = @folded
      ORDER BY m.created DESC
      LIMIT @limit
    `;
    return this.db.prepare<Record<string, unknown>, MemoryRow>(sql).all({ folded, limit });
  }

  touchMemory(id: string, isoNow: string): void {
    this.db
      .prepare(`UPDATE memories SET last_referenced = @isoNow WHERE id = @id`)
      .run({ id, isoNow });
  }

  // ---------------------------------------------------------------------
  // Tags
  // ---------------------------------------------------------------------

  addTags(memoryId: string, tags: string[]): void {
    const insert = this.db.prepare(`INSERT INTO memory_tags (memory_id, tag) VALUES (@memoryId, @tag)`);
    const insertMany = this.db.transaction((values: string[]) => {
      for (const tag of values) {
        insert.run({ memoryId, tag });
      }
    });
    insertMany(tags);
  }

  getTags(memoryId: string): string[] {
    const rows = this.db
      .prepare<{ memoryId: string }, { tag: string }>(
        `SELECT tag FROM memory_tags WHERE memory_id = @memoryId`,
      )
      .all({ memoryId });
    return rows.map((r) => r.tag);
  }

  // ---------------------------------------------------------------------
  // Approvals
  // ---------------------------------------------------------------------

  insertApproval(row: ApprovalRow): void {
    this.db
      .prepare(
        `INSERT INTO approvals
           (id, held_operation, zone, reason, session, state, created_at, resolved_at)
         VALUES (@id, @held_operation, @zone, @reason, @session, @state, @created_at, @resolved_at)`,
      )
      .run(row);
  }

  getApproval(id: string): ApprovalRow | null {
    const row = this.db
      .prepare<{ id: string }, ApprovalRow>(`SELECT * FROM approvals WHERE id = @id`)
      .get({ id });
    return row ?? null;
  }

  listApprovals(state?: ApprovalState): ApprovalRow[] {
    if (state === undefined) {
      return this.db
        .prepare<[], ApprovalRow>(`SELECT * FROM approvals ORDER BY created_at DESC`)
        .all();
    }
    return this.db
      .prepare<{ state: ApprovalState }, ApprovalRow>(
        `SELECT * FROM approvals WHERE state = @state ORDER BY created_at DESC`,
      )
      .all({ state });
  }

  setApprovalState(id: string, state: ApprovalState, resolvedAtIso?: string): void {
    this.db
      .prepare(`UPDATE approvals SET state = @state, resolved_at = @resolvedAt WHERE id = @id`)
      .run({ id, state, resolvedAt: resolvedAtIso ?? null });
  }

  // ---------------------------------------------------------------------
  // Conflicts
  // ---------------------------------------------------------------------

  /**
   * Insert a detected conflict, de-duplicated on (pair_lo, pair_hi, kind,
   * fact_key, value_hash) — the same contradictory pair/fact/VALUE re-
   * detected on a later `checkContradictions` run (e.g. after an unrelated
   * edit to either note) must not spawn a duplicate row, and — per the
   * dismissed-not-resurrected guarantee — must NOT reopen/touch a row a
   * human already dismissed or resolved. `value_hash` (see
   * `contradiction/valueHash.ts`) is part of the key specifically so that
   * dismissing a conflict on a given pair+fact does NOT swallow a later
   * contradiction on that same pair+fact with a DIFFERENT value -- the old
   * 4-column key (pair_lo, pair_hi, kind, fact_key) omitted the values
   * entirely, so a genuinely new contradiction collided with a dismissed row
   * and was silently dropped. Returns whether a new row was actually
   * inserted.
   */
  insertConflict(row: ConflictRow): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO conflicts
           (id, memory_a, memory_b, pair_lo, pair_hi, kind, fact_key, value_hash, entity, detail, created_at, state, resolved_at)
         VALUES (@id, @memory_a, @memory_b, @pair_lo, @pair_hi, @kind, @fact_key, @value_hash, @entity, @detail, @created_at, @state, @resolved_at)
         ON CONFLICT(pair_lo, pair_hi, kind, fact_key, value_hash) DO NOTHING`,
      )
      .run(row);
    return result.changes > 0;
  }

  listConflicts(state?: string): ConflictRow[] {
    if (state === undefined) {
      return this.db
        .prepare<[], ConflictRow>(`SELECT * FROM conflicts ORDER BY created_at DESC`)
        .all();
    }
    return this.db
      .prepare<{ state: string }, ConflictRow>(
        `SELECT * FROM conflicts WHERE state = @state ORDER BY created_at DESC`,
      )
      .all({ state });
  }

  getConflict(id: string): ConflictRow | null {
    const row = this.db
      .prepare<{ id: string }, ConflictRow>(`SELECT * FROM conflicts WHERE id = @id`)
      .get({ id });
    return row ?? null;
  }

  setConflictState(id: string, state: string, resolvedAtIso?: string): void {
    this.db
      .prepare(`UPDATE conflicts SET state = @state, resolved_at = @resolvedAt WHERE id = @id`)
      .run({ id, state, resolvedAt: resolvedAtIso ?? null });
  }

  // ---------------------------------------------------------------------
  // Memory relations (v0.3b distillation edges)
  // ---------------------------------------------------------------------

  /**
   * Insert a distillation->source edge. Idempotent: `ON CONFLICT DO NOTHING`
   * against the (memory_id, source_id, kind) primary key means re-running
   * reindex (or re-writing the same note) never duplicates an edge.
   */
  insertRelation(row: MemoryRelationRow): void {
    this.db
      .prepare(
        `INSERT INTO memory_relations (memory_id, source_id, kind)
         VALUES (@memory_id, @source_id, @kind)
         ON CONFLICT(memory_id, source_id, kind) DO NOTHING`,
      )
      .run(row);
  }

  /**
   * Remove every edge for a given distillation memory. Used to rebuild a
   * memory's relation set from scratch (reindex) and by undo (v0.3b, later)
   * to unwind a distillation's citations.
   */
  deleteRelationsForMemory(memory_id: string): void {
    this.db.prepare(`DELETE FROM memory_relations WHERE memory_id = @memory_id`).run({ memory_id });
  }

  /** Every source a given distillation memory cites. */
  getRelationsForMemory(memory_id: string): MemoryRelationRow[] {
    return this.db
      .prepare<{ memory_id: string }, MemoryRelationRow>(
        `SELECT * FROM memory_relations WHERE memory_id = @memory_id`,
      )
      .all({ memory_id });
  }

  /** Every distillation edge citing a given source (indexed lookup via
   * ix_memory_relations_source). */
  getDistillationsCitingSource(source_id: string): MemoryRelationRow[] {
    return this.db
      .prepare<{ source_id: string }, MemoryRelationRow>(
        `SELECT * FROM memory_relations WHERE source_id = @source_id`,
      )
      .all({ source_id });
  }
}
