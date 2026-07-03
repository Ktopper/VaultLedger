import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatch } from "diff";
import { simpleGit } from "simple-git";
import { Broker } from "../../src/broker/broker.js";
import { LedgerGit } from "../../src/broker/git.js";
import { Journal } from "../../src/journal/journal.js";
import { openJournal } from "../../src/journal/db.js";
import { hashBytes } from "../../src/broker/hash.js";
import { BrokerError } from "../../src/errors.js";
import { undoSession, undoTransaction } from "../../src/broker/undo.js";
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

  test("undoTransaction marks the linked memory row reverted", async () => {
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
    // to exercise undoTransaction's memory-compensation branch we mark the
    // broker-recorded row as already reverted (so it's inert) and record a
    // second, memory-linked row against the SAME real commit. Reverting that
    // linked row performs a real git revert of the (not-yet-reverted) commit.
    journal.setTransactionStatus(reviseResult.txnId!, "reverted");
    const linkedTxnId = genId("txn");
    journal.recordTransaction({
      id: linkedTxnId,
      op: "revise",
      path: "Agent/Memory/m.md",
      hash_before: hashBytes(Buffer.from(original, "utf8")),
      hash_after: hashBytes(Buffer.from(updated, "utf8")),
      session: "s1",
      reason: "linked to memory",
      memory_id: "mem_2",
      commit_sha: reviseResult.commitSha!,
      created_at: now(),
      status: "applied",
    });

    await undoTransaction({ git, journal, now, genId }, linkedTxnId);

    expect(journal.getMemory("mem_2")?.status).toBe("reverted");
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
});
