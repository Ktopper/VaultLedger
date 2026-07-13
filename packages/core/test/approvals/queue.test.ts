import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createPatch } from "diff";
import { Broker } from "../../src/broker/broker.js";
import { UNSAFE_NO_LOCK } from "../../src/concurrency/lock.js";
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
    const broker = new Broker({
      vaultRoot,
      git,
      journal,
      manifest: MANIFEST,
      now,
      genId,
      lockDir: UNSAFE_NO_LOCK,
    });
    const store = new MemoryStore({ broker, journal, now, genId, vaultRoot, manifest: MANIFEST });
    const approvals = new Approvals({ broker, store, journal, now, vaultRoot, genId, manifest: MANIFEST });
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

  // MEDIUM-2 (follow-up review): an approved canonical revise applies via
  // dispatchApply, which never re-enters store.revise -- so it must run
  // checkContradictions here too, or a human-approved revise that flips a
  // canonical value against another live belief goes unflagged until --rescan.
  test("CONTRADICTION COVERAGE: an approved canonical revise that flips a value against another live belief is flagged at approve time (not only on --rescan)", async () => {
    const { approvals, store, journal, vaultRoot } = await makeHarness();

    // A and B are two canonical beliefs on the same entity, initially agreeing.
    const a = await store.remember({ content: "deadline: 2026-08-15", entity: "nova", reason: "seed", session: "s1" });
    await store.setStatus(a.id, "canonical", "durable", "s1");
    const b = await store.remember({ content: "deadline: 2026-08-15", entity: "nova", reason: "seed", session: "s1" });
    await store.setStatus(b.id, "canonical", "durable", "s1");
    expect(journal.listConflicts("open")).toHaveLength(0); // agree -> no conflict

    // Queue + approve a canonical revise of B that flips its deadline to
    // contradict A. The revise lands via dispatchApply.
    const before = readFileSync(join(vaultRoot, b.path), "utf8");
    const after = before.replace("deadline: 2026-08-15", "deadline: 2026-09-01");
    const patchText = createPatch(b.path, before, after);
    const queued = await store.revise({ id: b.id, patch: patchText, reason: "revise deadline", session: "s1" });
    const approvalId = (queued as { queued: true; approvalId: string }).approvalId;

    await approvals.approve(approvalId);

    // The contradiction (B's 2026-09-01 vs A's 2026-08-15 on `deadline`) is
    // flagged NOW, at approve time -- no --rescan needed.
    const open = journal.listConflicts("open");
    expect(open).toHaveLength(1);
    expect(open[0]!.kind).toBe("value-conflict");
    expect(open[0]!.fact_key).toBe("deadline");
    expect([open[0]!.memory_a, open[0]!.memory_b].sort()).toEqual([a.id, b.id].sort());
  });

  // VL-SEC-S7-02 (queue.ts call site): dispatchApply's post-commit
  // checkContradictions hook (the "OTHER" content-changing revise surface,
  // alongside MemoryStore.revise's own call — see dispatchApply's doc
  // comment) MUST route its peer-file read through the same
  // containment/zone gate as every other checkContradictions call site.
  // Without `manifest` threaded into ApprovalsOptions this call site would
  // stay a live route to the excluded-content leak even after check.ts,
  // store.ts, and reindex.ts are all fixed -- `ledger approve` reaching a
  // canonical-revise is exactly the path this test exercises.
  test("VL-SEC-S7-02: an approved canonical revise's post-commit contradiction check does not leak an excluded-zone peer's content into conflicts.detail", async () => {
    const { approvals, store, journal, vaultRoot, git } = await makeHarness();

    // The legitimate canonical belief that will be revised via the queue.
    const source = await store.remember({
      content: "deadline: 2026-08-15",
      entity: "nova",
      reason: "seed",
      session: "s1",
    });
    await store.setStatus(source.id, "canonical", "durable", "s1");

    // A same-entity, live "peer" whose path resolves to the manifest's
    // excluded zone (Private/**) -- simulating either a hostile/forged path
    // reaching the journal, or an excluded note that slipped past a future
    // producer regression. The file genuinely exists and genuinely
    // contradicts the source's deadline, so the ONLY thing standing between
    // this and a content leak is the containment/zone gate, not an ENOENT.
    const secretRelPath = "Private/secret.md";
    await seedTrustedNote(git, vaultRoot, secretRelPath, "deadline: 1999-01-01\nssn: 555-11-2222\n");
    journal.insertMemory({
      id: "mem_excluded_peer",
      path: secretRelPath,
      entity: "nova",
      status: "working",
      confidence: "medium",
      created: "2026-01-01T00:00:00.000Z",
      source: "human-import",
      supersedes: null,
      expires: null,
      last_referenced: null,
    });

    // Canonical revise, queued then approved -- lands via dispatchApply,
    // NOT store.revise (see EXECUTION CONTRACT on MemoryStore.revise).
    const before = readFileSync(join(vaultRoot, source.path), "utf8");
    const after = before.replace("deadline: 2026-08-15", "deadline: 2026-09-01");
    const patchText = createPatch(source.path, before, after);
    const queued = await store.revise({ id: source.id, patch: patchText, reason: "revise", session: "s1" });
    const approvalId = (queued as { queued: true; approvalId: string }).approvalId;

    const result = await approvals.approve(approvalId);
    expect(result).toEqual({ applied: true });

    // The excluded peer's secret content must never appear anywhere in the
    // journal's conflicts (the surface `ledger conflicts`/`GET /conflicts`
    // reads).
    const allConflicts = journal.listConflicts();
    for (const c of allConflicts) {
      expect(c.detail ?? "").not.toContain("555-11-2222");
      expect(c.detail ?? "").not.toContain("1999-01-01");
    }
    // No conflict row should even reference the excluded peer's id -- the
    // read was refused before any comparison against it could happen.
    expect(allConflicts.some((c) => c.memory_a === "mem_excluded_peer" || c.memory_b === "mem_excluded_peer")).toBe(
      false,
    );
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

  // -------------------------------------------------------------------
  // VL-SEC-S2-03: the generic human-approved-via-queue path must NOT bypass
  // the ledger guard just because `approved:true` is set. Before the fix,
  // broker.ts's `applyRevise` gated the guard on bare `!approved`, so ANY
  // approved revise -- including one dispatched here, through
  // Approvals.approve -> dispatchApply -> broker.apply({approved:true,
  // approvalId}) -- skipped governedProvenanceChanged entirely. Combined
  // with VL-SEC-S2-01 (jsdiff applies a hunk wherever its content actually
  // matches, not necessarily where its header claims), a patch whose
  // rendered diff looks like an innocuous body-line edit could silently
  // flip `ledger.status` underneath an approving human. S2-01's landing
  // check (patch.ts) now rejects the relocation outright with SYNTAX_BREAK
  // before this guard is even reached, so this test also incidentally
  // proves S2-01 covers the approved path end-to-end -- but the assertions
  // below are written against `governedProvenanceChanged` semantics
  // (LEDGER_GUARD) in case a future change ever narrows S2-01's check.
  // -------------------------------------------------------------------
  test("VL-SEC-S2-03: an approved propose_edit whose declared hunk position lies about touching governed ledger.status is rejected, not silently applied", async () => {
    const { approvals, broker, journal, vaultRoot, git } = await makeHarness();

    const before = [
      "---",
      "ledger:",
      "  status: working",
      "  supersedes: null",
      'entity: "Acme Corp"',
      "---",
      "# Acme Corp status",
      "",
      "This quarter's revenue projection needs an update.",
      "The team is reviewing the Q3 numbers this week.",
      "",
    ].join("\n");
    const relPath = "Projects/acme-status.md";
    await seedTrustedNote(git, vaultRoot, relPath, before);
    const expectedHash = hashFile(join(vaultRoot, relPath));

    // The diff a human reviewer would see (approve.ts renders op.patch
    // verbatim): header + context claim this touches body line 9 (an
    // innocuous wording tweak). The actual removed/context line,
    // "  status: working", occurs ONLY inside the ledger: frontmatter
    // block (line 3) -- not at line 9.
    const lyingPatch = [
      "--- a/acme-status.md",
      "+++ b/acme-status.md",
      "@@ -9,1 +9,1 @@",
      "-  status: working",
      "+  status: canonical",
      "",
    ].join("\n");

    const queued = await broker.apply({
      op: "propose_edit",
      path: relPath,
      expected_hash: expectedHash,
      patch: lyingPatch,
      reason: "tweak wording in Q3 status note",
      session: "attacker-agent",
    });
    if (!("queued" in queued) || !queued.queued) throw new Error("expected a queued result");

    // The human approves, believing (from the rendered diff) they're
    // approving an unrelated body-wording edit.
    let thrown: unknown;
    try {
      await approvals.approve(queued.approvalId);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    // Either rejection is an acceptable fix outcome: S2-01's landing check
    // fires first (SYNTAX_BREAK, since the hunk relocates out of its
    // declared range), but LEDGER_GUARD would also be correct if S2-01 ever
    // narrowed. What must NEVER happen is a silent, successful apply.
    expect(["SYNTAX_BREAK", "LEDGER_GUARD"]).toContain((thrown as BrokerError).code);

    // The file must be byte-for-byte untouched and the approval must stay
    // pending -- neither a swallowed rejection nor a stale auto-close.
    expect(readFileSync(join(vaultRoot, relPath), "utf8")).toBe(before);
    expect(journal.getApproval(queued.approvalId)!.state).toBe("pending");
  });

  test("VL-SEC-S2-03: even an HONEST, correctly-addressed approved propose_edit is rejected if it targets governed ledger.status — propose_edit/revise is never the sanctioned channel for governance changes, only promote/forget/retire are", async () => {
    const { approvals, journal, vaultRoot, git, broker } = await makeHarness();

    const before = [
      "---",
      "ledger:",
      "  status: working",
      "  supersedes: null",
      'entity: "Acme Corp"',
      "---",
      "# Acme Corp status",
      "",
      "Body text.",
      "",
    ].join("\n");
    const relPath = "Projects/acme-status-2.md";
    await seedTrustedNote(git, vaultRoot, relPath, before);
    const expectedHash = hashFile(join(vaultRoot, relPath));

    // An honest patch: header correctly names line 3 (the real location of
    // `status: working`), no relocation trick involved. Even so, a generic
    // approved-via-queue revise must NOT be allowed to change governed
    // provenance — the sanctioned channel is MemoryStore.promote/forget/
    // retire (which flip status via the INTERNAL approved:true-without-
    // approvalId path, not this one). Rejecting this is intentional, not
    // over-blocking: see the sibling "no over-blocking" test below for the
    // case this guard must NOT catch.
    const honestPatch = [
      "--- a/acme-status-2.md",
      "+++ b/acme-status-2.md",
      "@@ -3,1 +3,1 @@",
      "-  status: working",
      "+  status: canonical",
      "",
    ].join("\n");

    const queued = await broker.apply({
      op: "propose_edit",
      path: relPath,
      expected_hash: expectedHash,
      patch: honestPatch,
      reason: "promote to canonical",
      session: "human-reviewer",
    });
    if (!("queued" in queued) || !queued.queued) throw new Error("expected a queued result");

    let thrown: unknown;
    try {
      await approvals.approve(queued.approvalId);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("LEDGER_GUARD");
    expect(readFileSync(join(vaultRoot, relPath), "utf8")).toBe(before);
    expect(journal.getApproval(queued.approvalId)!.state).toBe("pending");
  });

  test("VL-SEC-S2-03 no-over-blocking control: an approved propose_edit on a note WITH a ledger block, that touches only a non-governed field, still applies", async () => {
    const { approvals, broker, journal, vaultRoot, git } = await makeHarness();
    const before = [
      "---",
      "ledger:",
      "  status: working",
      "  supersedes: null",
      'entity: "Acme Corp"',
      "deadline: 2026-01-01",
      "---",
      "# Acme Corp status",
      "",
      "Body text.",
      "",
    ].join("\n");
    const relPath = "Projects/acme-status-3.md";
    await seedTrustedNote(git, vaultRoot, relPath, before);
    const expectedHash = hashFile(join(vaultRoot, relPath));

    const after = before.replace("deadline: 2026-01-01", "deadline: 2026-06-01");
    const patchText = createPatch("acme-status-3.md", before, after);

    const queued = await broker.apply({
      op: "propose_edit",
      path: relPath,
      expected_hash: expectedHash,
      patch: patchText,
      reason: "reschedule",
      session: "human-reviewer",
    });
    if (!("queued" in queued) || !queued.queued) throw new Error("expected a queued result");

    const result = await approvals.approve(queued.approvalId);
    expect(result).toEqual({ applied: true });
    expect(readFileSync(join(vaultRoot, relPath), "utf8")).toBe(after);
    expect(matter(readFileSync(join(vaultRoot, relPath), "utf8")).data.ledger.status).toBe(
      "working",
    );
    expect(journal.getApproval(queued.approvalId)!.state).toBe("approved");
  });
});
