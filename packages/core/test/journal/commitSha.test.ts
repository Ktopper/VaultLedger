import { describe, expect, test, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openJournal } from "../../src/journal/db.js";
import { Journal, type TransactionRow } from "../../src/journal/journal.js";
import { LedgerGit, formatMessage } from "../../src/broker/git.js";
import { reindex } from "../../src/memory/reindex.js";
import type { PermissionsManifest } from "../../src/schemas/manifest.js";

const MANIFEST: PermissionsManifest = {
  version: 1,
  mode: "assisted",
  zones: {
    agent: ["Agent/**"],
    scratch: ["Agent/Scratch/**"],
    excluded: ["Private/**"],
    trusted: ["**"],
  },
  overrides: [],
};

function makeClock(): { now: () => string; genId: (prefix: string) => string } {
  let tick = 0;
  let counter = 0;
  return {
    now: () => {
      tick += 1;
      return new Date(2026, 0, 1, 0, 0, tick).toISOString();
    },
    genId: (prefix: string) => {
      counter += 1;
      return `${prefix}_${counter}`;
    },
  };
}

function row(overrides: Partial<TransactionRow> = {}): TransactionRow {
  return {
    id: "tx_1",
    op: "create",
    path: "Nova.md",
    hash_before: null,
    hash_after: "sha256:abc",
    session: "session-a",
    reason: "seed",
    memory_id: null,
    commit_sha: "deadbeef",
    approval_id: null,
    created_at: "2026-07-01T00:00:00.000Z",
    status: "applied",
    ...overrides,
  };
}

describe("UNIQUE(commit_sha) partial index", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test("ux_transactions_commit is created as a unique partial index, and re-opening the same file is idempotent", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-commitsha-"));
    const dbPath = join(dir, "journal.db");

    const db1 = openJournal(dbPath);
    const indexList1 = db1
      .prepare("pragma index_list(transactions)")
      .all() as Array<{ name: string; unique: number; partial: number }>;
    const ux1 = indexList1.find((i) => i.name === "ux_transactions_commit");
    expect(ux1).toBeDefined();
    expect(ux1!.unique).toBe(1);
    expect(ux1!.partial).toBe(1);
    db1.close();

    // Re-opening the same on-disk file must not throw (CREATE ... IF NOT
    // EXISTS is idempotent) and the index must still be exactly there once.
    const db2 = openJournal(dbPath);
    const indexList2 = db2
      .prepare("pragma index_list(transactions)")
      .all() as Array<{ name: string; unique: number; partial: number }>;
    expect(indexList2.filter((i) => i.name === "ux_transactions_commit")).toHaveLength(1);
    db2.close();
  });

  test("recordTransactionIfNew: a duplicate non-null commit_sha converges to ONE row instead of throwing", () => {
    const journal = new Journal(openJournal(":memory:"));

    const first = journal.recordTransactionIfNew(row({ id: "tx_1", commit_sha: "sha-shared" }));
    expect(first).toBe(true);

    expect(() =>
      journal.recordTransactionIfNew(row({ id: "tx_2", commit_sha: "sha-shared" })),
    ).not.toThrow();
    const second = journal.recordTransactionIfNew(row({ id: "tx_2", commit_sha: "sha-shared" }));
    expect(second).toBe(false);

    const rows = journal.listTransactions({}).filter((t) => t.commit_sha === "sha-shared");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("tx_1");
  });

  test("recordTransactionIfNew: two NULL commit_sha rows are BOTH allowed (partial index doesn't apply)", () => {
    const journal = new Journal(openJournal(":memory:"));

    const first = journal.recordTransactionIfNew(row({ id: "tx_1", commit_sha: null }));
    const second = journal.recordTransactionIfNew(row({ id: "tx_2", commit_sha: null }));
    expect(first).toBe(true);
    expect(second).toBe(true);

    const rows = journal.listTransactions({}).filter((t) => t.commit_sha === null);
    expect(rows).toHaveLength(2);
  });

  test("concurrent reindex converges: two independent reindex passes racing on the same missing commit insert exactly ONE transaction row", async () => {
    dir = mkdtempSync(join(tmpdir(), "vl-commitsha-reindex-"));
    const vaultRoot = join(dir, "vault");
    const dbPath = join(dir, "journal.db");
    mkdirSync(vaultRoot, { recursive: true });

    const git = new LedgerGit(vaultRoot);
    await git.init();
    writeFileSync(join(vaultRoot, "race.md"), "race content\n", "utf8");
    const sha = await git.commitFile(
      "race.md",
      formatMessage({ op: "create", basename: "race.md", session: "session-a" }),
    );

    // Two separate Journal instances over the SAME on-disk journal file,
    // modeling two processes (e.g. `ledger serve` + an MCP server) each
    // independently reindexing the same vault. Both are forced to see
    // hasCommit()=false for this sha — the race window where neither has yet
    // observed the other's insert of the missing commit.
    const journalA = new Journal(openJournal(dbPath));
    const journalB = new Journal(openJournal(dbPath));
    vi.spyOn(journalA, "hasCommit").mockReturnValue(false);
    vi.spyOn(journalB, "hasCommit").mockReturnValue(false);

    const { now, genId } = makeClock();
    const resultA = await reindex({ vaultRoot, git, journal: journalA, manifest: MANIFEST, now, genId });
    const resultB = await reindex({ vaultRoot, git, journal: journalB, manifest: MANIFEST, now, genId });

    // Both passes believed the commit needed repair, but only one row landed.
    expect(resultA.transactions).toBe(1);
    expect(resultB.transactions).toBe(0);

    const rows = journalA.listTransactions({}).filter((t) => t.commit_sha === sha);
    expect(rows).toHaveLength(1);
  });

  test("upgrading a pre-existing journal with duplicate commit_sha rows does not throw; dedups to ONE row and still creates the unique index", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-commitsha-dupe-"));
    const dbPath = join(dir, "journal.db");

    // Simulate a v0.2 journal that hit the reindex race BEFORE the unique
    // index existed: build the transactions table directly (raw inserts, no
    // openJournal involved yet) with TWO rows sharing one commit_sha.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE transactions (
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
    `);
    raw
      .prepare(
        `INSERT INTO transactions
           (id, op, path, hash_before, hash_after, session, reason, memory_id, commit_sha, approval_id, created_at, status)
         VALUES (@id, @op, @path, @hash_before, @hash_after, @session, @reason, @memory_id, @commit_sha, @approval_id, @created_at, @status)`,
      )
      .run(row({ id: "tx_dup_1", commit_sha: "dupe-sha", created_at: "2026-07-01T00:00:00.000Z" }));
    raw
      .prepare(
        `INSERT INTO transactions
           (id, op, path, hash_before, hash_after, session, reason, memory_id, commit_sha, approval_id, created_at, status)
         VALUES (@id, @op, @path, @hash_before, @hash_after, @session, @reason, @memory_id, @commit_sha, @approval_id, @created_at, @status)`,
      )
      .run(row({ id: "tx_dup_2", commit_sha: "dupe-sha", created_at: "2026-07-02T00:00:00.000Z" }));
    raw.close();

    // openJournal must NOT throw (pre-fix: CREATE UNIQUE INDEX on the
    // duplicate commit_sha rows throws "UNIQUE constraint failed").
    let db: ReturnType<typeof openJournal> | undefined;
    expect(() => {
      db = openJournal(dbPath);
    }).not.toThrow();

    const indexList = db!
      .prepare("pragma index_list(transactions)")
      .all() as Array<{ name: string; unique: number }>;
    expect(indexList.find((i) => i.name === "ux_transactions_commit")).toBeDefined();

    const remaining = db!
      .prepare("SELECT id FROM transactions WHERE commit_sha = 'dupe-sha'")
      .all() as Array<{ id: string }>;
    expect(remaining).toHaveLength(1);
    db!.close();

    // Idempotent: opening the (now-deduped) file a second time still works.
    const db2 = openJournal(dbPath);
    expect(
      (db2.prepare("SELECT id FROM transactions WHERE commit_sha = 'dupe-sha'").all() as unknown[])
        .length,
    ).toBe(1);
    db2.close();
  });
});
