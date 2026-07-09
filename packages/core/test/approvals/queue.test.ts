import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
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
    const approvals = new Approvals({ broker, store, journal, now, vaultRoot, genId });
    return { approvals, broker, store, journal, git, vaultRoot, now, genId };
  }

  /** Write a trusted note directly to disk and commit it, so it exists at HEAD. */
  async function seedTrustedNote(
    git: LedgerGit,
    vaultRoot: string,
    relPath: string,
    content: string,
  ): Promise<void> {
    const abs = join(vaultRoot, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
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
    expect(approval!.stale_reason).toBe("STALE_HASH");
  });

  test("approve() on a held retire whose target was forgotten out from under it stales (INVALID_TRANSITION) instead of throwing and leaving a zombie pending approval", async () => {
    const { approvals, store, journal } = await makeHarness();

    const { id: memId } = await store.remember({
      content: "well established fact, later forgotten before its retire is approved",
      reason: "seed",
      session: "s1",
    });
    await store.setStatus(memId, "canonical", "approved as durable belief", "s1");

    // Queue a canonical retire (held for approval).
    const retireQueued = await store.retire({ id: memId, reason: "superseded", session: "s1" });
    expect(retireQueued).toHaveProperty("queued", true);
    const retireApprovalId = (retireQueued as { queued: true; approvalId: string }).approvalId;

    // Now forget the SAME canonical memory and approve that forget first --
    // the world moves out from under the still-pending retire.
    const forgetQueued = await store.forget({ id: memId, reason: "dodge", session: "s1" });
    expect(forgetQueued).toHaveProperty("queued", true);
    const forgetApprovalId = (forgetQueued as { queued: true; approvalId: string }).approvalId;
    const forgetResult = await approvals.approve(forgetApprovalId);
    expect(forgetResult).toEqual({ applied: true });
    expect(journal.getMemory(memId)!.status).toBe("forgotten");

    // Approving the now-inapplicable retire must NOT throw -- it should
    // stale, recording why, and leave the memory untouched (still forgotten).
    const result = await approvals.approve(retireApprovalId);
    expect(result).toEqual({ stale: true });

    const approval = journal.getApproval(retireApprovalId);
    expect(approval!.state).toBe("stale");
    expect(approval!.stale_reason).toBe("INVALID_TRANSITION");
    expect(journal.getMemory(memId)!.status).toBe("forgotten");
  });

  test("approve() on a dispatch failure with a NON-allowlisted code (FORBIDDEN_ZONE) still throws and leaves the approval pending", async () => {
    const { approvals, journal, vaultRoot, git, genId } = await makeHarness();
    const original = "secret content\n";
    // MANIFEST's `excluded` zone is Private/**.
    await seedTrustedNote(git, vaultRoot, "Private/secret.md", original);
    const patchText = createPatch("Private/secret.md", original, original + "more\n");
    const expectedHash = hashFile(join(vaultRoot, "Private/secret.md"));

    // Manually enqueue a held revise targeting the excluded zone -- this
    // could never be queued via the normal broker.apply path (an excluded
    // revise rejects immediately), so it's built directly to exercise
    // dispatchApply's error handling on a non-allowlisted BrokerError code.
    const approvalId = approvals.enqueue(
      {
        op: "revise",
        path: "Private/secret.md",
        expected_hash: expectedHash,
        patch: patchText,
        reason: "sneak an edit",
        session: "s1",
      },
      "excluded-zone-probe",
      "sneak an edit",
      "s1",
      genId,
    );

    await expect(approvals.approve(approvalId)).rejects.toMatchObject({ code: "FORBIDDEN_ZONE" });
    expect(journal.getApproval(approvalId)!.state).toBe("pending");
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

  test("approve() dispatches a held retire op to store.retire({approved:true}), retiring a canonical memory", async () => {
    const { approvals, store, journal, vaultRoot } = await makeHarness();

    const { id: memId, path } = await store.remember({
      content: "well established fact to retire",
      reason: "seed",
      session: "s1",
    });
    await store.setStatus(memId, "canonical", "approved as durable belief", "s1");

    const queued = await store.retire({ id: memId, reason: "no longer current", session: "s1" });
    expect(queued).toHaveProperty("queued", true);
    const approvalId = (queued as { queued: true; approvalId: string }).approvalId;

    const result = await approvals.approve(approvalId);
    expect(result).toEqual({ applied: true });

    expect(journal.getMemory(memId)!.status).toBe("retired");
    const onDisk = matter(readFileSync(join(vaultRoot, path), "utf8"));
    expect(onDisk.data.ledger.status).toBe("retired");
    expect(onDisk.data.ledger.retired_reason).toBe("no longer current");
    expect(journal.getApproval(approvalId)!.state).toBe("approved");
  });

  test("reject() on a held retire leaves the memory canonical and unretired", async () => {
    const { approvals, store, journal, vaultRoot } = await makeHarness();

    const { id: memId, path } = await store.remember({
      content: "well established fact to keep",
      reason: "seed",
      session: "s1",
    });
    await store.setStatus(memId, "canonical", "approved as durable belief", "s1");
    const before = readFileSync(join(vaultRoot, path), "utf8");

    const queued = await store.retire({ id: memId, reason: "no longer current", session: "s1" });
    expect(queued).toHaveProperty("queued", true);
    const approvalId = (queued as { queued: true; approvalId: string }).approvalId;

    approvals.reject(approvalId);

    expect(journal.getMemory(memId)!.status).toBe("canonical");
    expect(readFileSync(join(vaultRoot, path), "utf8")).toBe(before);
    expect(journal.getApproval(approvalId)!.state).toBe("rejected");
  });

  test("approve() dispatches a held canonical-revise op: patches the file and marks the approval approved", async () => {
    const { approvals, store, journal, vaultRoot } = await makeHarness();

    const { id: memId, path } = await store.remember({
      content: "well established fact 3",
      reason: "seed",
      session: "s1",
    });
    await store.setStatus(memId, "canonical", "approved as durable belief", "s1");

    const before = readFileSync(join(vaultRoot, path), "utf8");
    const after = before.replace("well established fact 3", "well established fact 3, revised");
    const patchText = createPatch(path, before, after);
    const queued = await store.revise({ id: memId, patch: patchText, reason: "tighten wording", session: "s1" });
    expect(queued).toHaveProperty("queued", true);
    const approvalId = (queued as { queued: true; approvalId: string }).approvalId;
    expect(journal.getApproval(approvalId)!.zone).toBe("canonical-revise");

    const result = await approvals.approve(approvalId);

    expect(result).toEqual({ applied: true });
    expect(readFileSync(join(vaultRoot, path), "utf8")).toBe(after);
    expect(journal.getApproval(approvalId)!.state).toBe("approved");
    expect(journal.getMemory(memId)!.status).toBe("canonical");
  });

  test("reject() on a held canonical-revise leaves the file unchanged and the approval rejected", async () => {
    const { approvals, store, journal, vaultRoot } = await makeHarness();

    const { id: memId, path } = await store.remember({
      content: "well established fact 4",
      reason: "seed",
      session: "s1",
    });
    await store.setStatus(memId, "canonical", "approved as durable belief", "s1");

    const before = readFileSync(join(vaultRoot, path), "utf8");
    const after = before.replace("well established fact 4", "well established fact 4, revised");
    const patchText = createPatch(path, before, after);
    const queued = await store.revise({ id: memId, patch: patchText, reason: "tighten wording", session: "s1" });
    expect(queued).toHaveProperty("queued", true);
    const approvalId = (queued as { queued: true; approvalId: string }).approvalId;

    approvals.reject(approvalId);

    expect(readFileSync(join(vaultRoot, path), "utf8")).toBe(before);
    expect(journal.getApproval(approvalId)!.state).toBe("rejected");

    // Idempotency / crash-gap safety: re-approving an already-resolved
    // approval must not double-apply the patch -- it throws NOT_FOUND
    // (loadPending), mirroring the generic already-resolved guard.
    await expect(approvals.approve(approvalId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("SURFACE COVERAGE: an approved canonical-source revise applied via dispatchApply (NOT store.revise) flags a citing distillation stale on a fact change", async () => {
    // This is the hook-point pin (source-linked staleness, v0.3b-2): every
    // content-changing revise surface must trigger the source-linked
    // staleness check, not just `MemoryStore.revise`. A canonical-source
    // revise's actual APPLY runs through `Approvals.approve` ->
    // `dispatchApply` -> `Broker.apply` directly -- it never re-enters
    // `store.revise` (see that method's EXECUTION CONTRACT doc comment).
    const { approvals, store, journal, vaultRoot } = await makeHarness();

    const source = await store.remember({
      content: "deadline: 2026-01-01\nThe rollout plan is steady.",
      entity: "proj",
      reason: "seed",
      session: "s1",
    });
    const distillation = await store.distill({
      content: "Summary citing the deadline note.",
      sources: [source.id],
      reason: "summarize",
      session: "s1",
    });

    await store.promote({ id: source.id, target_status: "working", reason: "confirmed", session: "s1" });
    const promotion = await store.promote({
      id: source.id,
      target_status: "canonical",
      reason: "well established",
      session: "s1",
    });
    expect(promotion.promoted).toBe(false);
    const promoteResult = await approvals.approve(promotion.approvalId!);
    expect(promoteResult).toEqual({ applied: true });
    expect(journal.getMemory(source.id)!.status).toBe("canonical");

    // No stale-source conflict yet -- the source hasn't changed.
    expect(journal.listConflicts("open").filter((c) => c.kind === "stale-source")).toHaveLength(0);

    const before = readFileSync(join(vaultRoot, source.path), "utf8");
    const after = before.replace("deadline: 2026-01-01", "deadline: 2026-06-01");
    const patchText = createPatch(source.path, before, after);
    const queued = await store.revise({
      id: source.id,
      patch: patchText,
      reason: "deadline moved",
      session: "s1",
    });
    expect(queued).toHaveProperty("queued", true);
    const approvalId = (queued as { queued: true; approvalId: string }).approvalId;

    const result = await approvals.approve(approvalId);

    expect(result).toEqual({ applied: true });
    expect(readFileSync(join(vaultRoot, source.path), "utf8")).toBe(after);

    const stale = journal.listConflicts("open").filter((c) => c.kind === "stale-source");
    expect(stale).toHaveLength(1);
    expect([stale[0]!.memory_a, stale[0]!.memory_b]).toContain(distillation.id);
    expect([stale[0]!.memory_a, stale[0]!.memory_b]).toContain(source.id);
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
