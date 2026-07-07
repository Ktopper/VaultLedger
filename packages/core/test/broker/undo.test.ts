import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { createPatch } from "diff";
import { simpleGit } from "simple-git";
import { Broker } from "../../src/broker/broker.js";
import { LedgerGit } from "../../src/broker/git.js";
import { Journal } from "../../src/journal/journal.js";
import { openJournal } from "../../src/journal/db.js";
import { hashBytes } from "../../src/broker/hash.js";
import { BrokerError } from "../../src/errors.js";
import { undoSession, undoTransaction } from "../../src/broker/undo.js";
import { MemoryStore } from "../../src/memory/store.js";
import { recall } from "../../src/recall/recall.js";
import { Conflicts } from "../../src/conflicts/queue.js";
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

describe("undo", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  async function makeHarness(): Promise<{
    broker: Broker;
    journal: Journal;
    git: LedgerGit;
    vaultRoot: string;
    now: () => string;
    genId: (prefix: string) => string;
  }> {
    const vaultRoot = mkdtempSync(join(tmpdir(), "vl-undo-"));
    dir = vaultRoot;
    const git = new LedgerGit(vaultRoot);
    await git.init();
    const db = openJournal(":memory:");
    const journal = new Journal(db);
    const { now, genId } = makeClock();
    const broker = new Broker({ vaultRoot, git, journal, manifest: MANIFEST, now, genId });
    return { broker, journal, git, vaultRoot, now, genId };
  }

  async function makeMemoryHarness(): Promise<{
    store: MemoryStore;
    journal: Journal;
    git: LedgerGit;
    vaultRoot: string;
    now: () => string;
    genId: (prefix: string) => string;
  }> {
    const vaultRoot = mkdtempSync(join(tmpdir(), "vl-undo-mem-"));
    dir = vaultRoot;
    const git = new LedgerGit(vaultRoot);
    await git.init();
    const db = openJournal(":memory:");
    const journal = new Journal(db);
    const { now, genId } = makeClock();
    const broker = new Broker({ vaultRoot, git, journal, manifest: MANIFEST, now, genId });
    const store = new MemoryStore({ broker, journal, now, genId, vaultRoot });
    return { store, journal, git, vaultRoot, now, genId };
  }

  test("undo of a revise to a PRE-EXISTING (untracked) note restores it, never deletes it (data-loss guard)", async () => {
    const { broker, journal, git, vaultRoot, now, genId } = await makeHarness();

    // A real user's note that existed on disk BEFORE VaultLedger touched it and
    // was never committed (init runs `git init` with no baseline commit).
    // Written directly, NOT through the broker.
    const original =
      "# Nova\n\nLaunch target is Q3.\nOwner is Alice.\nStatus is green.\nBudget is approved.\nNotes: none yet.\n";
    const rel = "Projects/Nova.md";
    mkdirSync(join(vaultRoot, "Projects"), { recursive: true });
    writeFileSync(join(vaultRoot, rel), original, "utf8");

    // An approved edit to that trusted-zone note through the broker.
    const updated =
      "# Nova\n\nLaunch target is Q4.\nOwner is Alice.\nStatus is green.\nBudget is approved.\nNotes: none yet.\n";
    const patchText = createPatch("Nova.md", original, updated);
    const reviseResult = await broker.apply(
      {
        op: "revise",
        path: rel,
        expected_hash: hashBytes(Buffer.from(original, "utf8")),
        patch: patchText,
        reason: "correct launch target",
        session: "s1",
      },
      { approved: true },
    );
    if (!reviseResult.ok || "queued" in reviseResult) throw new Error("expected applied");
    expect(readFileSync(join(vaultRoot, rel), "utf8")).toBe(updated);

    // Undo MUST restore the pre-edit note, never delete the user's file or lose
    // its original bytes. Before the baseline fix, revert of the edit commit
    // (the file's first-ever git appearance) DELETED the note.
    await undoTransaction({ git, journal, now, genId }, reviseResult.txnId!);
    expect(existsSync(join(vaultRoot, rel))).toBe(true);
    expect(readFileSync(join(vaultRoot, rel), "utf8")).toBe(original);
  });

  test("undoTransaction reverts a revise back to the exact pre-revise bytes and records a revert transaction", async () => {
    const { broker, journal, git, vaultRoot, now, genId } = await makeHarness();

    const original = "line1\nline2\nline3\n";
    await broker.apply({
      op: "create",
      path: "Agent/Memory/doc.md",
      content: original,
      reason: "seed",
      session: "s1",
    });

    const updated = "line1\nline2\nline3\nline4\n";
    const patchText = createPatch("doc.md", original, updated);
    const reviseResult = await broker.apply({
      op: "revise",
      path: "Agent/Memory/doc.md",
      expected_hash: hashBytes(Buffer.from(original, "utf8")),
      patch: patchText,
      reason: "append",
      session: "s1",
    });
    if (!reviseResult.ok || "queued" in reviseResult) throw new Error("expected applied");
    const reviseTxnBefore = journal.getTransaction(reviseResult.txnId!)!;

    const { revertSha, revertTxnId } = await undoTransaction(
      { git, journal, now, genId },
      reviseResult.txnId!,
    );

    expect(revertSha).toMatch(/^[0-9a-f]{40}$/);
    const bytes = readFileSync(join(vaultRoot, "Agent/Memory/doc.md"), "utf8");
    expect(bytes).toBe(original);

    const reviseTxnAfter = journal.getTransaction(reviseResult.txnId!);
    expect(reviseTxnAfter!.status).toBe("reverted");

    const revertTxn = journal.getTransaction(revertTxnId);
    expect(revertTxn).not.toBeNull();
    expect(revertTxn!.op).toBe("revert");
    expect(revertTxn!.status).toBe("applied");
    expect(revertTxn!.commit_sha).toBe(revertSha);
    expect(revertTxn!.path).toBe(reviseTxnBefore.path);
    expect(revertTxn!.hash_before).toBe(reviseTxnBefore.hash_after);
    expect(revertTxn!.hash_after).toBe(reviseTxnBefore.hash_before);
  });

  // NOTE: this test previously asserted that undoing ANY memory-linked
  // transaction blindly marks the memory row 'reverted'. That encoded the
  // bug under fix: `MemoryStore.revise()` links every content-edit
  // transaction to its memory, so undoing a routine revise made a live,
  // correct memory silently vanish from `recall`. The fix re-derives the
  // memory's status from the FILE at HEAD after the revert (spec §6.0).
  // Here the file has no `ledger:` frontmatter to parse (it's a plain-text
  // note, not one created via MemoryStore.remember), so the fail-safe
  // behavior applies: leave the status UNCHANGED rather than guessing
  // 'reverted' — losing a live memory from recall is the worse failure.
  test("undoTransaction on a revise-linked memory with unparseable frontmatter leaves status unchanged (fail-safe)", async () => {
    const { broker, journal, git, now, genId } = await makeHarness();

    const original = "a\nb\nc\n";
    await broker.apply({
      op: "create",
      path: "Agent/Memory/m.md",
      content: original,
      reason: "seed",
      session: "s1",
    });

    const updated = "a\nb\nc\nd\n";
    const patchText = createPatch("m.md", original, updated);
    const reviseResult = await broker.apply({
      op: "revise",
      path: "Agent/Memory/m.md",
      expected_hash: hashBytes(Buffer.from(original, "utf8")),
      patch: patchText,
      reason: "append",
      session: "s1",
    });
    if (!reviseResult.ok || "queued" in reviseResult) throw new Error("expected applied");

    journal.insertMemory({
      id: "mem_2",
      path: "Agent/Memory/m.md",
      entity: null,
      status: "active",
      confidence: null,
      created: now(),
      source: null,
      supersedes: null,
      expires: null,
      last_referenced: null,
    });

    // Broker.apply() itself never links a memory_id onto the transaction it
    // records (that's the memory store's job, out of scope for Phase 2c), so
    // to exercise undoTransaction's memory-compensation branch we link
    // memory_id onto the broker-recorded row directly via
    // setTransactionMemoryId — the same real API the memory store itself
    // uses (see Journal.setTransactionMemoryId), rather than recording a
    // second row against the SAME real commit (which would now collide with
    // the ux_transactions_commit unique index).
    journal.setTransactionMemoryId(reviseResult.txnId!, "mem_2");

    await undoTransaction({ git, journal, now, genId }, reviseResult.txnId!);

    // The file at HEAD is back to "a\nb\nc\n" — real content, but no `ledger:`
    // frontmatter block to parse a status out of. Status must stay exactly
    // what it was ("active"), NOT flip to 'reverted'.
    expect(journal.getMemory("mem_2")?.status).toBe("active");
  });

  test("undoTransaction on an already-reverted transaction throws ALREADY_REVERTED", async () => {
    const { broker, journal, git, now, genId } = await makeHarness();

    const original = "hello\nworld\nfoo\n";
    await broker.apply({
      op: "create",
      path: "Agent/Memory/n.md",
      content: original,
      reason: "seed",
      session: "s1",
    });
    const patchText = createPatch("n.md", original, "hello\nworld\nfoo\nbar\n");
    const reviseResult = await broker.apply({
      op: "revise",
      path: "Agent/Memory/n.md",
      expected_hash: hashBytes(Buffer.from(original, "utf8")),
      patch: patchText,
      reason: "r",
      session: "s1",
    });
    if (!reviseResult.ok || "queued" in reviseResult) throw new Error("expected applied");

    await undoTransaction({ git, journal, now, genId }, reviseResult.txnId!);

    let thrown: unknown;
    try {
      await undoTransaction({ git, journal, now, genId }, reviseResult.txnId!);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("ALREADY_REVERTED");
  });

  test("undoTransaction on an unknown txnId throws NOT_FOUND", async () => {
    const { journal, git, now, genId } = await makeHarness();
    let thrown: unknown;
    try {
      await undoTransaction({ git, journal, now, genId }, "txn_does_not_exist");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("NOT_FOUND");
  });

  test("undoTransaction on a transaction with commit_sha=null throws NOT_FOUND", async () => {
    const { journal, git, now, genId } = await makeHarness();
    const txnId = genId("txn");
    journal.recordTransaction({
      id: txnId,
      op: "create",
      path: "Agent/Memory/nocommit.md",
      hash_before: null,
      hash_after: "sha256:abc",
      session: "s1",
      reason: "no commit recorded",
      memory_id: null,
      commit_sha: null,
      approval_id: null,
      created_at: now(),
      status: "applied",
    });

    let thrown: unknown;
    try {
      await undoTransaction({ git, journal, now, genId }, txnId);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("NOT_FOUND");
    // The transaction must NOT have been marked reverted.
    expect(journal.getTransaction(txnId)!.status).toBe("applied");
  });

  test("dirty revert: REVERT_CONFLICT propagates, working tree stays clean, and the journal is untouched", async () => {
    const { broker, journal, git, vaultRoot, now, genId } = await makeHarness();

    const original = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n";
    const createResult = await broker.apply({
      op: "create",
      path: "Agent/Memory/conf.md",
      content: original,
      reason: "seed",
      session: "s1",
    });
    if (!createResult.ok || "queued" in createResult) throw new Error("expected applied");

    // A second revise changes one of the lines the create introduced (well
    // under the patch-size threshold), so the file at HEAD no longer matches
    // exactly what the create commit added. Reverting the create (txn A) —
    // which wants to delete the file as it was at A — now conflicts with
    // HEAD's independently-modified version (a modify/delete conflict).
    const changed = "alpha\nBETA\ngamma\ndelta\nepsilon\nzeta\n";
    const patchText = createPatch("conf.md", original, changed);
    await broker.apply({
      op: "revise",
      path: "Agent/Memory/conf.md",
      expected_hash: hashBytes(Buffer.from(original, "utf8")),
      patch: patchText,
      reason: "conflict maker",
      session: "s1",
    });

    let thrown: unknown;
    try {
      await undoTransaction({ git, journal, now, genId }, createResult.txnId!);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("REVERT_CONFLICT");

    // Working tree must be clean (no half-applied revert / no conflict markers left).
    const status = await simpleGit(vaultRoot).raw(["status", "--porcelain"]);
    expect(status.trim()).toBe("");

    // Journal must NOT have been mutated: txn A is still 'applied', and no
    // new revert transaction row was inserted.
    const txnAAfter = journal.getTransaction(createResult.txnId!);
    expect(txnAAfter!.status).toBe("applied");
    const allTxns = journal.listTransactions({});
    expect(allTxns.some((t) => t.op === "revert")).toBe(false);
  });

  test("undoSession reverts a session's applied transactions newest-first", async () => {
    const { broker, journal, git, now, genId } = await makeHarness();

    const r1 = await broker.apply({
      op: "create",
      path: "Agent/Memory/one.md",
      content: "one\n",
      reason: "seed",
      session: "session-x",
    });
    const r2 = await broker.apply({
      op: "create",
      path: "Agent/Memory/two.md",
      content: "two\n",
      reason: "seed",
      session: "session-x",
    });
    if (!r1.ok || "queued" in r1 || !r2.ok || "queued" in r2) {
      throw new Error("expected applied");
    }

    const results = await undoSession({ git, journal, now, genId }, "session-x");
    expect(results.map((r) => r.txnId).sort()).toEqual([r1.txnId, r2.txnId].sort());

    expect(journal.getTransaction(r1.txnId!)!.status).toBe("reverted");
    expect(journal.getTransaction(r2.txnId!)!.status).toBe("reverted");

    // Files should no longer exist at HEAD (both creates were reverted).
    expect(await git.fileAtHead("Agent/Memory/one.md")).toBeNull();
    expect(await git.fileAtHead("Agent/Memory/two.md")).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Re-derive memory status from the file (spec §6.0) — regression coverage
  // for the final-review bug: undo blindly marked ANY memory linked to the
  // undone transaction 'reverted', so undoing a routine content revise made
  // a live, correct memory silently vanish from `recall`.
  // ---------------------------------------------------------------------

  test("HEADLINE REGRESSION: undoing a revise restores file bytes but keeps the live memory in recall", async () => {
    const { store, journal, git, vaultRoot, now, genId } = await makeMemoryHarness();

    const { id, path } = await store.remember({
      content: "Alice prefers dark mode.",
      entity: "alice",
      reason: "observed preference",
      session: "s1",
    });
    const preReviseBytes = readFileSync(join(vaultRoot, path), "utf8");

    const postReviseBody = "Alice prefers dark mode.\nAlice also prefers tabs.";
    const patchText = createPatch(
      path,
      preReviseBytes,
      matter.stringify(postReviseBody, matter(preReviseBytes).data),
    );
    await store.revise({ id, patch: patchText, reason: "append fact", session: "s1" });

    const reviseTxn = journal
      .listTransactions({})
      .find((t) => t.op === "revise" && t.memory_id === id);
    expect(reviseTxn).toBeDefined();

    const { revertTxnId } = await undoTransaction({ git, journal, now, genId }, reviseTxn!.id);

    // (a) file bytes restored to the exact pre-revise content.
    const bytesAfterUndo = readFileSync(join(vaultRoot, path), "utf8");
    expect(bytesAfterUndo).toBe(preReviseBytes);

    // (b) recall STILL returns the memory — it did NOT vanish.
    expect(recall(journal, {}, now).map((r) => r.id)).toContain(id);

    // (c) the memory row status is re-derived from the file's frontmatter
    // (still 'scratch' — the revise never touched status).
    expect(journal.getMemory(id)!.status).toBe("scratch");

    // (d) the original revise txn is marked reverted and a new revert row exists.
    expect(journal.getTransaction(reviseTxn!.id)!.status).toBe("reverted");
    const revertRow = journal.getTransaction(revertTxnId);
    expect(revertRow).not.toBeNull();
    expect(revertRow!.op).toBe("revert");
  });

  test("undoing the CREATE transaction still marks the memory reverted and drops it from recall", async () => {
    const { store, journal, git, now, genId } = await makeMemoryHarness();

    const { id, path, txnId } = await store.remember({
      content: "ephemeral fact",
      entity: "bob",
      reason: "seed",
      session: "s1",
    });
    expect(recall(journal, {}, now).map((r) => r.id)).toContain(id);

    await undoTransaction({ git, journal, now, genId }, txnId);

    expect(await git.fileAtHead(path)).toBeNull();
    expect(journal.getMemory(id)!.status).toBe("reverted");
    expect(recall(journal, {}, now).map((r) => r.id)).not.toContain(id);
  });

  test("undoing a CREATE transaction hides its open conflict via the both-sides-live filter (no proactive moot)", async () => {
    const { store, journal, git, now, genId } = await makeMemoryHarness();

    const a = await store.remember({
      content: "Deadline: 2026-08-15",
      entity: "nova",
      reason: "seed",
      session: "s1",
    });
    await store.promote({ id: a.id, target_status: "working", reason: "confirmed", session: "s1" });

    // B's remember() runs the post-commit contradiction check and queues an
    // open conflict against A (differing deadline).
    const b = await store.remember({
      content: "Deadline: 2026-09-01",
      entity: "nova",
      reason: "seed",
      session: "s1",
    });
    const openBefore = journal.listConflicts("open");
    expect(openBefore).toHaveLength(1);
    const conflictId = openBefore[0]!.id;

    await undoTransaction({ git, journal, now, genId }, b.txnId);

    expect(journal.getMemory(b.id)!.status).toBe("reverted");
    // The raw journal row's OWN state is untouched (still 'open' — undo no
    // longer proactively moots it); it disappears from the enriched,
    // both-sides-live Conflicts.list('open') solely because B is now dead.
    expect(journal.getConflict(conflictId)!.state).toBe("open");
    const conflicts = new Conflicts(journal);
    expect(conflicts.list("open")).toHaveLength(0);
  });

  test("undo of an UNRELATED revise on a live memory does NOT hide a still-open conflict (regression: undo used to moot ANY open conflict naming the memory, even one untouched by the undone txn)", async () => {
    const { store, journal, vaultRoot, git, now, genId } = await makeMemoryHarness();

    // A and B: two LIVE (working) peers with a genuine, still-valid
    // deadline conflict between them.
    const a = await store.remember({
      content: "Deadline: 2026-08-15\nOwner: Alice",
      entity: "nova",
      reason: "seed",
      session: "s1",
    });
    await store.promote({ id: a.id, target_status: "working", reason: "confirmed", session: "s1" });

    const b = await store.remember({
      content: "Deadline: 2026-09-01",
      entity: "nova",
      reason: "seed",
      session: "s1",
    });
    await store.promote({ id: b.id, target_status: "working", reason: "confirmed", session: "s1" });

    const conflicts = new Conflicts(journal);
    const openBefore = conflicts.list("open");
    expect(openBefore).toHaveLength(1);
    const conflictId = openBefore[0]!.row.id;

    // Revise A's UNRELATED "Owner" line — nothing to do with the deadline
    // conflict — then undo that revise. A stays live throughout.
    const before = readFileSync(join(vaultRoot, a.path), "utf8");
    const after = before.replace("Owner: Alice", "Owner: Bob");
    const patchText = createPatch(a.path, before, after);
    await store.revise({ id: a.id, patch: patchText, reason: "unrelated correction", session: "s1" });

    const reviseTxn = journal
      .listTransactions({ entity: "nova" })
      .find((t) => t.memory_id === a.id && t.op === "revise");
    expect(reviseTxn).toBeDefined();

    await undoTransaction({ git, journal, now, genId }, reviseTxn!.id);

    // A is still live (the revise-undo restores content, not status).
    expect(journal.getMemory(a.id)!.status).toBe("working");
    // The deadline conflict must STILL be open and visible — it was never
    // touched by the unrelated revise/undo.
    expect(journal.getConflict(conflictId)!.state).toBe("open");
    expect(conflicts.list("open").map((c) => c.row.id)).toContain(conflictId);
  });

  test("undoing a promote (scratch->working) txn re-derives the memory status back to 'scratch' from the file", async () => {
    const { store, journal, git, vaultRoot, now, genId } = await makeMemoryHarness();

    const { id, path } = await store.remember({
      content: "durable fact",
      reason: "seed",
      session: "s1",
    });

    await store.promote({ id, target_status: "working", reason: "confirmed", session: "s1" });
    expect(journal.getMemory(id)!.status).toBe("working");
    expect(matter(readFileSync(join(vaultRoot, path), "utf8")).data.ledger.status).toBe("working");

    const promoteTxn = journal
      .listTransactions({})
      .find((t) => t.op === "revise" && t.memory_id === id);
    expect(promoteTxn).toBeDefined();

    await undoTransaction({ git, journal, now, genId }, promoteTxn!.id);

    // Git reverted the frontmatter status flip back to 'scratch'...
    const onDisk = matter(readFileSync(join(vaultRoot, path), "utf8"));
    expect(onDisk.data.ledger.status).toBe("scratch");
    // ...and the memory row is re-derived from the file, not blindly reverted.
    expect(journal.getMemory(id)!.status).toBe("scratch");
    expect(recall(journal, {}, now).map((r) => r.id)).toContain(id);
  });
});
