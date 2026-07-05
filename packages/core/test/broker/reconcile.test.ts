import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerGit, formatMessage } from "../../src/broker/git.js";
import { Journal, type ApprovalRow, type TransactionRow } from "../../src/journal/journal.js";
import { openJournal } from "../../src/journal/db.js";
import { reconcile } from "../../src/broker/reconcile.js";

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

describe("reconcile", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  async function makeHarness(): Promise<{
    journal: Journal;
    git: LedgerGit;
    vaultRoot: string;
    now: () => string;
    genId: (prefix: string) => string;
  }> {
    const vaultRoot = mkdtempSync(join(tmpdir(), "vl-reconcile-"));
    dir = vaultRoot;
    const git = new LedgerGit(vaultRoot);
    await git.init();
    const db = openJournal(":memory:");
    const journal = new Journal(db);
    const { now, genId } = makeClock();
    return { journal, git, vaultRoot, now, genId };
  }

  test("repairs a commit missing from the journal (simulated crash gap) and parses op/session/memoryId", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();

    // Commit 1: recorded normally in the journal (as the broker would do).
    writeFileSync(join(vaultRoot, "a.md"), "a content\n", "utf8");
    const shaA = await git.commitFile(
      "a.md",
      formatMessage({ op: "create", basename: "a.md", session: "session-a" }),
    );
    const txnA: TransactionRow = {
      id: genId("txn"),
      op: "create",
      path: "a.md",
      hash_before: null,
      hash_after: "sha256:deadbeef",
      session: "session-a",
      reason: "seed",
      memory_id: null,
      commit_sha: shaA,
      created_at: now(),
      status: "applied",
    };
    journal.recordTransaction(txnA);

    // Commit 2: lands in git, but the process "crashes" before the journal
    // write happens — this is the gap reconcile must repair. Include a
    // memoryId segment to verify message parsing.
    writeFileSync(join(vaultRoot, "b.md"), "b content\n", "utf8");
    const shaB = await git.commitFile(
      "b.md",
      formatMessage({
        op: "revise",
        basename: "b.md",
        memoryId: "mem_7f2a",
        session: "session-b",
      }),
    );

    expect(journal.hasCommit(shaA)).toBe(true);
    expect(journal.hasCommit(shaB)).toBe(false);

    const result = await reconcile({ git, journal, now, genId });
    expect(result.repaired).toBe(1);

    expect(journal.hasCommit(shaB)).toBe(true);
    const repairedRow = journal
      .listTransactions({})
      .find((t) => t.commit_sha === shaB);
    expect(repairedRow).toBeDefined();
    expect(repairedRow!.op).toBe("revise");
    expect(repairedRow!.path).toBe("b.md");
    expect(repairedRow!.session).toBe("session-b");
    expect(repairedRow!.memory_id).toBe("mem_7f2a");
    expect(repairedRow!.status).toBe("applied");
    expect(repairedRow!.commit_sha).toBe(shaB);
  });

  test("is idempotent: a second run repairs nothing further", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();

    writeFileSync(join(vaultRoot, "only.md"), "content\n", "utf8");
    await git.commitFile(
      "only.md",
      formatMessage({ op: "create", basename: "only.md", session: "session-a" }),
    );
    // Nothing recorded in the journal for this commit — simulate the gap.

    const first = await reconcile({ git, journal, now, genId });
    expect(first.repaired).toBe(1);

    const second = await reconcile({ git, journal, now, genId });
    expect(second.repaired).toBe(0);
  });

  test("recovers a basename WITH SPACES and a [memoryId] segment", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();

    writeFileSync(join(vaultRoot, "My Note.md"), "spaced\n", "utf8");
    const sha = await git.commitFile(
      "My Note.md",
      formatMessage({
        op: "revise",
        basename: "My Note.md",
        memoryId: "mem_1",
        session: "session-b",
      }),
    );
    // Confirm the recorded message really does contain spaces in the basename.
    const commits = await git.listLedgerCommits();
    expect(commits.find((c) => c.sha === sha)!.message).toBe(
      "ledger: revise My Note.md [mem_1] session-b",
    );

    const result = await reconcile({ git, journal, now, genId });
    expect(result.repaired).toBe(1);

    const repaired = journal.listTransactions({}).find((t) => t.commit_sha === sha)!;
    expect(repaired.op).toBe("revise");
    expect(repaired.path).toBe("My Note.md");
    expect(repaired.session).toBe("session-b");
    expect(repaired.memory_id).toBe("mem_1");
  });

  test("recovers a basename WITH SPACES and NO memoryId, leaving memory_id null", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();

    writeFileSync(join(vaultRoot, "Another Note.md"), "spaced\n", "utf8");
    const sha = await git.commitFile(
      "Another Note.md",
      formatMessage({ op: "create", basename: "Another Note.md", session: "session-a" }),
    );
    expect(
      (await git.listLedgerCommits()).find((c) => c.sha === sha)!.message,
    ).toBe("ledger: create Another Note.md session-a");

    const result = await reconcile({ git, journal, now, genId });
    expect(result.repaired).toBe(1);

    const repaired = journal.listTransactions({}).find((t) => t.commit_sha === sha)!;
    expect(repaired.op).toBe("create");
    expect(repaired.path).toBe("Another Note.md");
    expect(repaired.session).toBe("session-a");
    expect(repaired.memory_id).toBeNull();
  });
});

describe("reconcile: closes stale pending approvals (approve->apply crash gap)", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  async function makeHarness(): Promise<{
    journal: Journal;
    git: LedgerGit;
    vaultRoot: string;
    now: () => string;
    genId: (prefix: string) => string;
  }> {
    const vaultRoot = mkdtempSync(join(tmpdir(), "vl-reconcile-approvals-"));
    dir = vaultRoot;
    const git = new LedgerGit(vaultRoot);
    await git.init();
    const db = openJournal(":memory:");
    const journal = new Journal(db);
    const { now, genId } = makeClock();
    return { journal, git, vaultRoot, now, genId };
  }

  function pendingApproval(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
    return {
      id: "apr_1",
      held_operation: JSON.stringify({
        op: "propose_edit",
        path: "Projects/Nova.md",
        expected_hash: "sha256:deadbeef",
        patch: "--- a\n+++ b\n",
        reason: "edit nova",
        session: "session-a",
      }),
      zone: "restricted",
      reason: "needs sign-off",
      session: "session-a",
      state: "pending",
      created_at: "2026-07-01T00:00:00.000Z",
      resolved_at: null,
      ...overrides,
    };
  }

  function appliedTxn(overrides: Partial<TransactionRow> = {}): TransactionRow {
    return {
      id: "txn_1",
      op: "revise",
      path: "Projects/Nova.md",
      hash_before: "sha256:before",
      hash_after: "sha256:after",
      session: "session-a",
      reason: "applied",
      memory_id: null,
      commit_sha: "sha-nova-1",
      created_at: "2026-07-02T00:00:00.000Z",
      status: "applied",
      ...overrides,
    };
  }

  test("a pending approval with a LATER applied transaction on the same path is closed to 'approved'", async () => {
    const { journal, git, now, genId } = await makeHarness();

    // Both timestamps come off the SAME injected clock, in the order they'd
    // really happen: the approval is created first (tick 1), then the crash
    // gap's applied transaction lands later (tick 2).
    const approvalCreatedAt = now();
    journal.insertApproval(pendingApproval({ id: "apr_1", created_at: approvalCreatedAt }));
    const txnCreatedAt = now();
    journal.recordTransaction(
      appliedTxn({ id: "txn_1", commit_sha: "sha-nova-1", created_at: txnCreatedAt }),
    );

    await reconcile({ git, journal, now, genId });

    const approval = journal.getApproval("apr_1")!;
    expect(approval.state).toBe("approved");
    expect(approval.resolved_at).not.toBeNull();
  });

  test("an unrelated pending approval (no matching applied transaction) is left 'pending'", async () => {
    const { journal, git, now, genId } = await makeHarness();

    const approvalCreatedAt = now();
    journal.insertApproval(
      pendingApproval({
        id: "apr_unrelated",
        created_at: approvalCreatedAt,
        held_operation: JSON.stringify({
          op: "propose_edit",
          path: "Projects/Orion.md",
          expected_hash: "sha256:x",
          patch: "--- a\n+++ b\n",
          reason: "edit orion",
          session: "session-a",
        }),
      }),
    );
    // An applied transaction exists, but for a DIFFERENT path.
    const txnCreatedAt = now();
    journal.recordTransaction(
      appliedTxn({
        id: "txn_1",
        path: "Projects/Nova.md",
        commit_sha: "sha-nova-1",
        created_at: txnCreatedAt,
      }),
    );

    await reconcile({ git, journal, now, genId });

    const approval = journal.getApproval("apr_unrelated")!;
    expect(approval.state).toBe("pending");
    expect(approval.resolved_at).toBeNull();
  });

  test("a pending approval whose only matching transaction is BEFORE it is left 'pending' (conservative)", async () => {
    const { journal, git, now, genId } = await makeHarness();

    // The transaction was applied and committed BEFORE the approval was
    // created (tick 1) — it cannot be the result of approving THIS held op,
    // so reconcile must not close the approval on its account.
    const txnCreatedAt = now();
    journal.recordTransaction(
      appliedTxn({ id: "txn_1", commit_sha: "sha-nova-1", created_at: txnCreatedAt }),
    );
    const approvalCreatedAt = now();
    journal.insertApproval(pendingApproval({ id: "apr_1", created_at: approvalCreatedAt }));

    await reconcile({ git, journal, now, genId });

    const approval = journal.getApproval("apr_1")!;
    expect(approval.state).toBe("pending");
    expect(approval.resolved_at).toBeNull();
  });

  test("a reconcile-repaired row (path stored as BASENAME only) does NOT close a full-path approval (conservative)", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();

    const approvalCreatedAt = now();
    journal.insertApproval(pendingApproval({ id: "apr_1", created_at: approvalCreatedAt }));

    // Simulate a commit landing in git AFTER the approval was created, with no
    // journal row yet (the crash gap) — reconcile's FIRST pass (commit ->
    // transaction repair) inserts a row whose `path` is the BASENAME
    // ("Nova.md" — the directory is LOST), not the held op's full
    // vault-relative path ("Projects/Nova.md"). Because the directory is gone,
    // a basename-only row can't be distinguished from an unrelated
    // "Archive/Nova.md" commit, so it must NOT auto-close the approval. This
    // is the accepted rare double-fault miss: the approval stays 'pending'
    // (a human can still act on it), never a false-close.
    writeFileSync(join(vaultRoot, "Nova.md"), "content\n", "utf8");
    await git.commitFile(
      "Nova.md",
      formatMessage({ op: "revise", basename: "Nova.md", session: "session-a" }),
    );

    const result = await reconcile({ git, journal, now, genId });
    expect(result.repaired).toBe(1);

    const approval = journal.getApproval("apr_1")!;
    expect(approval.state).toBe("pending");
    expect(approval.resolved_at).toBeNull();
  });

  test("FALSE-CLOSE GUARD: an unrelated later basename-only applied txn does NOT close a full-path approval", async () => {
    const { journal, git, now, genId } = await makeHarness();

    // A pending approval whose held op targets "Projects/Nova.md".
    const approvalCreatedAt = now();
    journal.insertApproval(pendingApproval({ id: "apr_1", created_at: approvalCreatedAt }));

    // An unrelated LATER applied transaction stored with only the BASENAME
    // "Nova.md" (as reconcile's commit-repair pass would record it) — but it
    // actually belongs to a DIFFERENT-folder note (e.g. "Archive/Nova.md").
    // The directory is lost in the basename-only row, so matching on basename
    // would FALSE-CLOSE the "Projects/Nova.md" approval. Full-path-only
    // matching must leave it pending.
    const txnCreatedAt = now();
    journal.recordTransaction(
      appliedTxn({ id: "txn_1", path: "Nova.md", commit_sha: "sha-archive-nova", created_at: txnCreatedAt }),
    );

    const result = await reconcile({ git, journal, now, genId });
    expect(result.approvalsClosed).toBe(0);

    const approval = journal.getApproval("apr_1")!;
    expect(approval.state).toBe("pending");
    expect(approval.resolved_at).toBeNull();
  });
});
