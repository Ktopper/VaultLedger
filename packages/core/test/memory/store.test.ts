import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { createPatch } from "diff";
import { Broker } from "../../src/broker/broker.js";
import { LedgerGit } from "../../src/broker/git.js";
import { Journal } from "../../src/journal/journal.js";
import { openJournal } from "../../src/journal/db.js";
import { hashFile } from "../../src/broker/hash.js";
import { BrokerError } from "../../src/errors.js";
import { MemoryStore } from "../../src/memory/store.js";
import { recall } from "../../src/recall/recall.js";
import { undoTransaction } from "../../src/broker/undo.js";
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

describe("MemoryStore", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  async function makeStore(): Promise<{
    store: MemoryStore;
    journal: Journal;
    vaultRoot: string;
    git: LedgerGit;
    now: () => string;
    genId: (prefix: string) => string;
  }> {
    const vaultRoot = mkdtempSync(join(tmpdir(), "vl-memstore-"));
    dir = vaultRoot;
    const git = new LedgerGit(vaultRoot);
    await git.init();
    const db = openJournal(":memory:");
    const journal = new Journal(db);
    const { now, genId } = makeClock();
    const broker = new Broker({ vaultRoot, git, journal, manifest: MANIFEST, now, genId });
    const store = new MemoryStore({ broker, journal, now, genId, vaultRoot });
    return { store, journal, vaultRoot, git, now, genId };
  }

  test("remember creates a note under Agent/Memory with ledger frontmatter and a journal row", async () => {
    const { store, journal, vaultRoot } = await makeStore();

    const { id, path } = await store.remember({
      content: "Alice prefers dark mode.",
      entity: "alice",
      reason: "observed preference",
      session: "s1",
      tags: ["preferences", "ui"],
    });

    expect(path).toBe(`Agent/Memory/${id}.md`);
    const raw = readFileSync(join(vaultRoot, path), "utf8");
    const parsed = matter(raw);
    expect(parsed.data.ledger).toMatchObject({
      id,
      status: "scratch",
      source: "s1",
      reason: "observed preference",
      confidence: "medium",
      supersedes: null,
      expires: null,
    });
    expect(parsed.content.trim()).toBe("Alice prefers dark mode.");

    const row = journal.getMemory(id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("scratch");
    expect(row!.entity).toBe("alice");
    expect(row!.path).toBe(path);
    expect(journal.getTags(id).sort()).toEqual(["preferences", "ui"]);
  });

  test("remember returns the create txnId and links memory_id onto that transaction", async () => {
    const { store, journal } = await makeStore();
    const result = await store.remember({ content: "x", reason: "seed", session: "s1" });
    expect(result.txnId).toBeDefined();
    const txn = journal.getTransaction(result.txnId);
    expect(txn).not.toBeNull();
    expect(txn!.op).toBe("create");
    expect(txn!.memory_id).toBe(result.id);
  });

  test("undo of a remember's create transaction reverts the memory row and drops it from recall", async () => {
    const { store, journal, git, vaultRoot, now, genId } = await makeStore();

    const { id, path, txnId } = await store.remember({
      content: "ephemeral fact",
      entity: "alice",
      reason: "seed",
      session: "s1",
    });
    // Sanity: the memory is recallable and its file exists before undo.
    expect(existsSync(join(vaultRoot, path))).toBe(true);
    expect(recall(journal, { entity: "alice" }, now).map((r) => r.id)).toContain(id);

    await undoTransaction({ git, journal, now, genId }, txnId);

    // File is gone at HEAD (create reverted)...
    expect(await git.fileAtHead(path)).toBeNull();
    // ...and the memory row is now 'reverted', so recall no longer returns it.
    expect(journal.getMemory(id)!.status).toBe("reverted");
    expect(recall(journal, { entity: "alice" }, now).map((r) => r.id)).not.toContain(id);
  });

  test("revise patches the note through the broker", async () => {
    const { store, vaultRoot } = await makeStore();
    const { id, path } = await store.remember({
      content: "line1\nline2",
      reason: "seed",
      session: "s1",
    });

    const before = readFileSync(join(vaultRoot, path), "utf8");
    const after = before + "\nline3";
    const patchText = createPatch(path, before, after);

    await store.revise({ id, patch: patchText, reason: "append line3", session: "s1" });

    const written = readFileSync(join(vaultRoot, path), "utf8");
    expect(written).toBe(after);
  });

  test("promote scratch -> working updates the journal row and returns promoted:true", async () => {
    const { store, journal } = await makeStore();
    const { id } = await store.remember({ content: "x", reason: "seed", session: "s1" });

    const result = await store.promote({
      id,
      target_status: "working",
      reason: "confirmed twice",
      session: "s1",
    });

    expect(result).toEqual({ promoted: true });
    expect(journal.getMemory(id)!.status).toBe("working");
  });

  test("promote scratch -> working writes status 'working' into the file frontmatter (durable)", async () => {
    const { store, vaultRoot } = await makeStore();
    const { id, path } = await store.remember({ content: "durable fact", reason: "seed", session: "s1" });

    // Before promotion the file's ledger status is 'scratch'.
    expect(matter(readFileSync(join(vaultRoot, path), "utf8")).data.ledger.status).toBe("scratch");

    await store.promote({ id, target_status: "working", reason: "confirmed", session: "s1" });

    const onDisk = matter(readFileSync(join(vaultRoot, path), "utf8"));
    expect(onDisk.data.ledger.status).toBe("working");
    // The note body must be preserved through the frontmatter-only status edit.
    expect(onDisk.content.trim()).toBe("durable fact");
  });

  test("setStatus flips the file frontmatter, updates the journal row, and links the txn", async () => {
    const { store, journal, vaultRoot } = await makeStore();
    const { id, path } = await store.remember({ content: "note body", reason: "seed", session: "s1" });

    await store.setStatus(id, "working", "manual set", "s1");

    expect(matter(readFileSync(join(vaultRoot, path), "utf8")).data.ledger.status).toBe("working");
    expect(journal.getMemory(id)!.status).toBe("working");
    const reviseTxn = journal
      .listTransactions({})
      .find((t) => t.op === "revise" && t.memory_id === id);
    expect(reviseTxn).toBeDefined();
  });

  test("promote working -> canonical enqueues an approval and returns promoted:false", async () => {
    const { store, journal } = await makeStore();
    const { id } = await store.remember({ content: "x", reason: "seed", session: "s1" });
    await store.promote({ id, target_status: "working", reason: "r", session: "s1" });

    const result = await store.promote({
      id,
      target_status: "canonical",
      reason: "well-established fact",
      session: "s1",
    });

    expect(result.promoted).toBe(false);
    expect(result.approvalId).toBeDefined();
    const approval = journal.getApproval(result.approvalId!);
    expect(approval).not.toBeNull();
    expect(approval!.state).toBe("pending");
    // Memory row should remain "working" until the approval resolves.
    expect(journal.getMemory(id)!.status).toBe("working");
  });

  test("promote scratch -> canonical directly is an unsupported transition", async () => {
    const { store } = await makeStore();
    const { id } = await store.remember({ content: "x", reason: "seed", session: "s1" });

    let thrown: unknown;
    try {
      await store.promote({ id, target_status: "canonical", reason: "r", session: "s1" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("INVALID_TRANSITION");
  });

  test("forget archives the file and tombstones the journal row", async () => {
    const { store, journal, vaultRoot } = await makeStore();
    const { id, path } = await store.remember({ content: "to be forgotten", reason: "seed", session: "s1" });
    expect(existsSync(join(vaultRoot, path))).toBe(true);

    await store.forget({ id, reason: "no longer relevant", session: "s1" });

    expect(existsSync(join(vaultRoot, path))).toBe(false);
    const archivePath = `Agent/Archive/${id}.md`;
    expect(existsSync(join(vaultRoot, archivePath))).toBe(true);

    const row = journal.getMemory(id);
    expect(row!.status).toBe("forgotten");
    expect(row!.path).toBe(archivePath);

    // The forget transaction must be linked to the memory id.
    const forgetTxn = journal
      .listTransactions({})
      .find((t) => t.op === "forget" && t.memory_id === id);
    expect(forgetTxn).toBeDefined();
  });

  test("forget flips the archived note's frontmatter status to 'forgotten' (durable)", async () => {
    const { store, vaultRoot } = await makeStore();
    const { id } = await store.remember({ content: "soon gone", reason: "seed", session: "s1" });

    await store.forget({ id, reason: "no longer relevant", session: "s1" });

    const archivePath = `Agent/Archive/${id}.md`;
    const archived = matter(readFileSync(join(vaultRoot, archivePath), "utf8"));
    expect(archived.data.ledger.status).toBe("forgotten");
  });

  test("revise links its transaction to the memory id", async () => {
    const { store, journal, vaultRoot } = await makeStore();
    const { id, path } = await store.remember({ content: "line1\nline2", reason: "seed", session: "s1" });
    const before = readFileSync(join(vaultRoot, path), "utf8");
    const patchText = createPatch(path, before, before + "\nline3");

    await store.revise({ id, patch: patchText, reason: "append", session: "s1" });

    const reviseTxn = journal
      .listTransactions({})
      .find((t) => t.op === "revise" && t.memory_id === id);
    expect(reviseTxn).toBeDefined();
  });

  test("revise computes expected_hash via hashFile against the current on-disk content", async () => {
    const { store, vaultRoot } = await makeStore();
    const { id, path } = await store.remember({ content: "v1", reason: "seed", session: "s1" });
    const onDisk = readFileSync(join(vaultRoot, path), "utf8");
    expect(hashFile(join(vaultRoot, path))).toBeDefined();

    const patchText = createPatch(path, onDisk, onDisk + "\nv2");
    await store.revise({ id, patch: patchText, reason: "add v2", session: "s1" });
    expect(readFileSync(join(vaultRoot, path), "utf8")).toBe(onDisk + "\nv2");
  });

  test("remember queues a conflict when a live (working) same-entity peer already conflicts on a fact", async () => {
    const { store, journal } = await makeStore();
    const a = await store.remember({
      content: "Deadline: 2026-08-15",
      entity: "nova",
      reason: "seed",
      session: "s1",
    });
    // "working" (not just "canonical") is already a live status for the
    // contradiction entity matcher, so this is enough to make A a comparable
    // peer for B's post-remember check.
    await store.promote({ id: a.id, target_status: "working", reason: "confirmed", session: "s1" });

    await store.remember({
      content: "Deadline: 2026-09-01",
      entity: "nova",
      reason: "seed",
      session: "s1",
    });

    const open = journal.listConflicts("open");
    expect(open).toHaveLength(1);
    expect(open[0]!.fact_key).toBe("deadline");
    expect(open[0]!.kind).toBe("value-conflict");
  });

  test("remember does not queue a conflict for a non-contradicting same-entity peer", async () => {
    const { store, journal } = await makeStore();
    const a = await store.remember({
      content: "Deadline: 2026-08-15",
      entity: "nova",
      reason: "seed",
      session: "s1",
    });
    await store.promote({ id: a.id, target_status: "working", reason: "confirmed", session: "s1" });

    await store.remember({
      content: "Deadline: 2026-08-15",
      entity: "nova",
      reason: "seed",
      session: "s1",
    });

    expect(journal.listConflicts("open")).toHaveLength(0);
  });

  test("revise runs the contradiction check after the patch lands", async () => {
    const { store, journal, vaultRoot } = await makeStore();
    const a = await store.remember({
      content: "Owner: Alice",
      entity: "nova",
      reason: "seed",
      session: "s1",
    });
    await store.promote({ id: a.id, target_status: "working", reason: "confirmed", session: "s1" });

    const b = await store.remember({
      content: "Location: Paris",
      entity: "nova",
      reason: "seed",
      session: "s1",
    });
    // Sanity: no conflict yet (differing, unrelated fact).
    expect(journal.listConflicts("open")).toHaveLength(0);

    const before = readFileSync(join(vaultRoot, b.path), "utf8");
    const after = before.replace("Location: Paris", "Location: Paris\nOwner: Bob");
    const patchText = createPatch(b.path, before, after);
    await store.revise({ id: b.id, patch: patchText, reason: "add owner", session: "s1" });

    const open = journal.listConflicts("open");
    expect(open).toHaveLength(1);
    expect(open[0]!.fact_key).toBe("owner");
  });

  test("forget moots any open conflict referencing the forgotten memory", async () => {
    const { store, journal } = await makeStore();
    const a = await store.remember({
      content: "Deadline: 2026-08-15",
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
    const openBefore = journal.listConflicts("open");
    expect(openBefore).toHaveLength(1);
    const conflictId = openBefore[0]!.id;

    await store.forget({ id: b.id, reason: "no longer relevant", session: "s1" });

    expect(journal.getConflict(conflictId)!.state).toBe("moot");
    expect(journal.listConflicts("open")).toHaveLength(0);
  });
});
