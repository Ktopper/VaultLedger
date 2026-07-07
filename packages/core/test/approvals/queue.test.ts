import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatch } from "diff";
import { Broker } from "../../src/broker/broker.js";
import { LedgerGit } from "../../src/broker/git.js";
import { Journal } from "../../src/journal/journal.js";
import { openJournal } from "../../src/journal/db.js";
import matter from "gray-matter";
import { hashFile } from "../../src/broker/hash.js";
import { BrokerError } from "../../src/errors.js";
import { Approvals } from "../../src/approvals/queue.js";
import { MemoryStore } from "../../src/memory/store.js";
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

describe("Approvals", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  async function makeHarness(): Promise<{
    approvals: Approvals;
    broker: Broker;
    store: MemoryStore;
    journal: Journal;
    git: LedgerGit;
    vaultRoot: string;
    now: () => string;
    genId: (prefix: string) => string;
  }> {
    const vaultRoot = mkdtempSync(join(tmpdir(), "vl-approvals-"));
    dir = vaultRoot;
    const git = new LedgerGit(vaultRoot);
    await git.init();
    const db = openJournal(":memory:");
    const journal = new Journal(db);
    const { now, genId } = makeClock();
    const broker = new Broker({ vaultRoot, git, journal, manifest: MANIFEST, now, genId });
    const store = new MemoryStore({ broker, journal, now, genId, vaultRoot });
    const approvals = new Approvals({ broker, store, journal, now });
    return { approvals, broker, store, journal, git, vaultRoot, now, genId };
  }

  /** Write a trusted note directly to disk and commit it, so it exists at HEAD. */
  async function seedTrustedNote(
    git: LedgerGit,
    vaultRoot: string,
    relPath: string,
    content: string,
  ): Promise<void> {
    writeFileSync(join(vaultRoot, relPath), content, "utf8");
    await git.commitFile(relPath, `ledger: create ${relPath} seed`);
  }

  test("approve() applies a queued propose_edit: patches the file and marks the approval approved", async () => {
    const { approvals, broker, journal, vaultRoot, git } = await makeHarness();
    const original = "trusted line1\ntrusted line2\n";
    await seedTrustedNote(git, vaultRoot, "note.md", original);

    const updated = "trusted line1\ntrusted line2\ntrusted line3\n";
    const patchText = createPatch("note.md", original, updated);
    const expectedHash = hashFile(join(vaultRoot, "note.md"));

    const queued = await broker.apply({
      op: "propose_edit",
      path: "note.md",
      expected_hash: expectedHash,
      patch: patchText,
      reason: "suggest an addition",
      session: "s1",
    });
    if (!("queued" in queued) || !queued.queued) throw new Error("expected a queued result");

    const result = await approvals.approve(queued.approvalId);
    expect(result).toEqual({ applied: true });

    expect(readFileSync(join(vaultRoot, "note.md"), "utf8")).toBe(updated);
    const approval = journal.getApproval(queued.approvalId);
    expect(approval!.state).toBe("approved");
    expect(approval!.resolved_at).not.toBeNull();
  });

  test("approve() on a stale propose_edit marks the approval stale and leaves the file untouched", async () => {
    const { approvals, broker, journal, vaultRoot, git } = await makeHarness();
    const original = "trusted line1\ntrusted line2\n";
    await seedTrustedNote(git, vaultRoot, "stale.md", original);

    const updated = "trusted line1\ntrusted line2\ntrusted line3\n";
    const patchText = createPatch("stale.md", original, updated);
    const expectedHash = hashFile(join(vaultRoot, "stale.md"));

    const queued = await broker.apply({
      op: "propose_edit",
      path: "stale.md",
      expected_hash: expectedHash,
      patch: patchText,
      reason: "suggest an addition",
      session: "s1",
    });
    if (!("queued" in queued) || !queued.queued) throw new Error("expected a queued result");

    // The trusted note changes underneath the pending approval.
    const drifted = "trusted line1\ntrusted line2 EDITED\n";
    writeFileSync(join(vaultRoot, "stale.md"), drifted, "utf8");
    await git.commitFile("stale.md", "ledger: revise stale.md drift");

    const result = await approvals.approve(queued.approvalId);
    expect(result).toEqual({ stale: true });

    expect(readFileSync(join(vaultRoot, "stale.md"), "utf8")).toBe(drifted);
    const approval = journal.getApproval(queued.approvalId);
    expect(approval!.state).toBe("stale");
  });

  test("reject() marks the approval rejected and leaves the file untouched", async () => {
    const { approvals, journal, vaultRoot, git, broker } = await makeHarness();
    const original = "trusted content\n";
    await seedTrustedNote(git, vaultRoot, "rej.md", original);

    const patchText = createPatch("rej.md", original, original + "more\n");
    const expectedHash = hashFile(join(vaultRoot, "rej.md"));
    const queued = await broker.apply({
      op: "propose_edit",
      path: "rej.md",
      expected_hash: expectedHash,
      patch: patchText,
      reason: "r",
      session: "s1",
    });
    if (!("queued" in queued) || !queued.queued) throw new Error("expected a queued result");

    approvals.reject(queued.approvalId);

    expect(readFileSync(join(vaultRoot, "rej.md"), "utf8")).toBe(original);
    expect(journal.getApproval(queued.approvalId)!.state).toBe("rejected");
  });

  test("approve() dispatches a held promote op to store.setStatus, flipping BOTH the file and the journal to canonical", async () => {
    const { approvals, store, journal, vaultRoot, genId } = await makeHarness();

    // Seed a real working memory (a file on disk with ledger frontmatter), so
    // the canonical promotion has a file to flip — this proves the held
    // promote is applied via store.setStatus, not broker.apply.
    const { id: memId, path } = await store.remember({
      content: "well established fact",
      reason: "seed",
      session: "s1",
    });
    await store.promote({ id: memId, target_status: "working", reason: "confirmed", session: "s1" });

    const approvalId = approvals.enqueue(
      { op: "promote", id: memId, target_status: "canonical", reason: "well established", session: "s1" },
      "canonical-promotion",
      "well established",
      "s1",
      genId,
    );

    const result = await approvals.approve(approvalId);
    expect(result).toEqual({ applied: true });
    expect(journal.getMemory(memId)!.status).toBe("canonical");
    // Durable: the file frontmatter must also read canonical.
    expect(matter(readFileSync(join(vaultRoot, path), "utf8")).data.ledger.status).toBe("canonical");
    expect(journal.getApproval(approvalId)!.state).toBe("approved");
  });

  test("approve() dispatches a held forget op to store.forget({approved:true}), archiving a canonical memory", async () => {
    const { approvals, store, journal, vaultRoot } = await makeHarness();

    const { id: memId, path } = await store.remember({
      content: "well established fact",
      reason: "seed",
      session: "s1",
    });
    await store.setStatus(memId, "canonical", "approved as durable belief", "s1");

    const queued = await store.forget({ id: memId, reason: "dodge contradiction check", session: "s1" });
    expect(queued).toHaveProperty("queued", true);
    const approvalId = (queued as { queued: true; approvalId: string }).approvalId;

    const result = await approvals.approve(approvalId);
    expect(result).toEqual({ applied: true });

    expect(journal.getMemory(memId)!.status).toBe("forgotten");
    expect(existsSync(join(vaultRoot, path))).toBe(false);
    expect(existsSync(join(vaultRoot, `Agent/Archive/${memId}.md`))).toBe(true);
    expect(journal.getApproval(approvalId)!.state).toBe("approved");
  });

  test("reject() on a held forget leaves the memory canonical and un-archived", async () => {
    const { approvals, store, journal, vaultRoot } = await makeHarness();

    const { id: memId, path } = await store.remember({
      content: "well established fact 2",
      reason: "seed",
      session: "s1",
    });
    await store.setStatus(memId, "canonical", "approved as durable belief", "s1");

    const queued = await store.forget({ id: memId, reason: "dodge contradiction check", session: "s1" });
    expect(queued).toHaveProperty("queued", true);
    const approvalId = (queued as { queued: true; approvalId: string }).approvalId;

    approvals.reject(approvalId);

    expect(journal.getMemory(memId)!.status).toBe("canonical");
    expect(existsSync(join(vaultRoot, path))).toBe(true);
    expect(existsSync(join(vaultRoot, `Agent/Archive/${memId}.md`))).toBe(false);
    expect(journal.getApproval(approvalId)!.state).toBe("rejected");
  });

  test("approve() on an unknown id throws NOT_FOUND", async () => {
    const { approvals } = await makeHarness();
    await expect(approvals.approve("apr_does_not_exist")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("approve() on an already-resolved approval throws NOT_FOUND", async () => {
    const { approvals, broker, vaultRoot, git } = await makeHarness();
    const original = "trusted line1\ntrusted line2\n";
    await seedTrustedNote(git, vaultRoot, "twice.md", original);
    const patchText = createPatch("twice.md", original, original + "trusted line3\n");
    const queued = await broker.apply({
      op: "propose_edit",
      path: "twice.md",
      expected_hash: hashFile(join(vaultRoot, "twice.md")),
      patch: patchText,
      reason: "r",
      session: "s1",
    });
    if (!("queued" in queued) || !queued.queued) throw new Error("expected a queued result");

    await approvals.approve(queued.approvalId);

    let thrown: unknown;
    try {
      await approvals.approve(queued.approvalId);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("NOT_FOUND");
  });

  test("list() returns only pending approvals", async () => {
    const { approvals, broker, vaultRoot, git } = await makeHarness();
    const original = "trusted line1\ntrusted line2\n";
    await seedTrustedNote(git, vaultRoot, "pending.md", original);
    const patchText = createPatch("pending.md", original, original + "trusted line3\n");
    const queued = await broker.apply({
      op: "propose_edit",
      path: "pending.md",
      expected_hash: hashFile(join(vaultRoot, "pending.md")),
      patch: patchText,
      reason: "r",
      session: "s1",
    });
    if (!("queued" in queued) || !queued.queued) throw new Error("expected a queued result");

    expect(approvals.list().map((a) => a.id)).toContain(queued.approvalId);
    await approvals.approve(queued.approvalId);
    expect(approvals.list().map((a) => a.id)).not.toContain(queued.approvalId);
  });
});
