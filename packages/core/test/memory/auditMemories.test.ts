import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Broker } from "../../src/broker/broker.js";
import { LedgerGit } from "../../src/broker/git.js";
import { Journal } from "../../src/journal/journal.js";
import { openJournal } from "../../src/journal/db.js";
import { MemoryStore } from "../../src/memory/store.js";
import { undoTransaction } from "../../src/broker/undo.js";
import { reindex } from "../../src/memory/reindex.js";
import { auditMemories } from "../../src/memory/auditMemories.js";
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

describe("auditMemories", () => {
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
    broker: Broker;
    store: MemoryStore;
    vaultRoot: string;
    now: () => string;
    genId: (prefix: string) => string;
  }> {
    const vaultRoot = mkdtempSync(join(tmpdir(), "vl-audit-"));
    dir = vaultRoot;
    const git = new LedgerGit(vaultRoot);
    await git.init();
    const db = openJournal(":memory:");
    const journal = new Journal(db);
    const { now, genId } = makeClock();
    const broker = new Broker({ vaultRoot, git, journal, manifest: MANIFEST, now, genId });
    const store = new MemoryStore({ broker, journal, now, genId, vaultRoot });
    return { journal, git, broker, store, vaultRoot, now, genId };
  }

  test("post-hoc death: a source that dies AFTER being cited is flagged by a state-based scan", async () => {
    const { journal, git, store, vaultRoot, now, genId } = await makeHarness();

    const s = await store.remember({
      content: "Alice prefers dark mode.",
      entity: "alice",
      reason: "seed",
      session: "s1",
    });
    const d = await store.distill({
      content: "Alice's preferences summary.",
      sources: [s.id],
      reason: "summarize",
      session: "s1",
    });

    // No stale-source conflict exists yet -- the source was live at citation
    // time, and nothing has happened to it since.
    expect(journal.listConflicts("open").filter((c) => c.kind === "stale-source")).toEqual([]);

    // The source dies AFTER the citation: undo its create. Event-driven
    // detection (which only runs on retire/forget/revise of the source
    // itself) never sees this.
    await undoTransaction({ git, journal, now, genId }, s.txnId);
    expect(journal.getMemory(s.id)!.status).toBe("reverted");

    const result = auditMemories({ journal, vaultRoot, now, genId });

    expect(result.errors).toEqual([]);
    expect(result.pairs).toEqual([{ distillation: d.id, source: s.id, reason: "reverted" }]);
    expect(result.staleFlagged).toBe(1);

    const stale = journal.listConflicts("open").filter((c) => c.kind === "stale-source");
    expect(stale).toHaveLength(1);
    expect(stale[0]!.detail).toContain(`stale-source: ${d.id} cites ${s.id} now reverted (content GONE)`);
  });

  test("live source not flagged", async () => {
    const { journal, store, vaultRoot, now, genId } = await makeHarness();

    const s = await store.remember({
      content: "Alice prefers a compact layout.",
      entity: "alice",
      reason: "seed",
      session: "s1",
    });
    await store.distill({
      content: "Alice's preferences summary.",
      sources: [s.id],
      reason: "summarize",
      session: "s1",
    });

    const result = auditMemories({ journal, vaultRoot, now, genId });

    expect(result.pairs).toEqual([]);
    expect(result.staleFlagged).toBe(0);
    expect(result.errors).toEqual([]);
    expect(journal.listConflicts("open").filter((c) => c.kind === "stale-source")).toEqual([]);
  });

  // LOW-4 (follow-up review): an edge whose DISTILLATION side is itself
  // dead-or-gone is skipped — flagging it would insert a row the kind-aware
  // liveness filter permanently hides, and inflate the count. Isolated from the
  // event-driven flags: the source dies via UNDO (scan-only, no event), and the
  // distillation is forgotten (it cites nobody, so its forget fires no event).
  test("a dead-or-gone distillation is skipped (no moot, permanently-hidden row)", async () => {
    const { journal, git, store, vaultRoot, now, genId } = await makeHarness();

    const s = await store.remember({ content: "x: 1", entity: "nova", reason: "seed", session: "s1" });
    const d = await store.distill({ content: "summary", sources: [s.id], reason: "sum", session: "s1" });
    // Source dead WITHOUT firing the retire/forget event (undo is scan-only);
    // the d->s edge survives (undo of s removes only s's own outgoing edges).
    await undoTransaction({ git, journal, now, genId }, s.txnId);
    // Distillation itself dead (no event: d is cited by nobody).
    await store.forget({ id: d.id, reason: "drop distillation", session: "s1" });

    const result = auditMemories({ journal, vaultRoot, now, genId });

    // Without LOW-4 the reverted source would be flagged; with it, the dead
    // distillation's edge is skipped entirely.
    expect(result.pairs).toEqual([]);
    expect(result.staleFlagged).toBe(0);
    expect(journal.listConflicts("open").filter((c) => c.kind === "stale-source")).toEqual([]);
  });

  test("idempotent: a second run adds no new conflict rows", async () => {
    const { journal, git, store, vaultRoot, now, genId } = await makeHarness();

    const s = await store.remember({
      content: "Alice prefers dark mode.",
      entity: "alice",
      reason: "seed",
      session: "s1",
    });
    const d = await store.distill({
      content: "Alice's preferences summary.",
      sources: [s.id],
      reason: "summarize",
      session: "s1",
    });
    await undoTransaction({ git, journal, now, genId }, s.txnId);

    const first = auditMemories({ journal, vaultRoot, now, genId });
    expect(first.pairs).toEqual([{ distillation: d.id, source: s.id, reason: "reverted" }]);
    const afterFirst = journal.listConflicts("open").filter((c) => c.kind === "stale-source");
    expect(afterFirst).toHaveLength(1);

    const second = auditMemories({ journal, vaultRoot, now, genId });
    expect(second.pairs).toEqual([{ distillation: d.id, source: s.id, reason: "reverted" }]);
    const afterSecond = journal.listConflicts("open").filter((c) => c.kind === "stale-source");
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]!.id).toBe(afterFirst[0]!.id);
  });

  test("retired + forgotten sources are flagged with the right reason and contentId", async () => {
    const { journal, store, vaultRoot, now, genId } = await makeHarness();

    const retiredSource = await store.remember({
      content: "Alice prefers dark mode.",
      entity: "alice",
      reason: "seed",
      session: "s1",
    });
    const distillationOfRetired = await store.distill({
      content: "Distillation citing a soon-to-be-retired source.",
      sources: [retiredSource.id],
      reason: "summarize",
      session: "s1",
    });
    await store.setStatus(retiredSource.id, "retired", "superseded", "s1");

    const forgottenSource = await store.remember({
      content: "Alice prefers a compact layout.",
      entity: "alice",
      reason: "seed",
      session: "s1",
    });
    const distillationOfForgotten = await store.distill({
      content: "Distillation citing a soon-to-be-forgotten source.",
      sources: [forgottenSource.id],
      reason: "summarize",
      session: "s1",
    });
    await store.forget({ id: forgottenSource.id, reason: "no longer relevant", session: "s1" });

    const result = auditMemories({ journal, vaultRoot, now, genId });

    expect(result.errors).toEqual([]);
    const pairs = [...result.pairs].sort((a, b) => a.source.localeCompare(b.source));
    expect(pairs).toEqual(
      [
        { distillation: distillationOfRetired.id, source: retiredSource.id, reason: "retired" },
        { distillation: distillationOfForgotten.id, source: forgottenSource.id, reason: "forgotten" },
      ].sort((a, b) => a.source.localeCompare(b.source)),
    );

    const stale = journal.listConflicts("open").filter((c) => c.kind === "stale-source");
    expect(stale).toHaveLength(2);
    // Neither reason's contentId is GONE -- both files still exist on disk
    // (retired: in place; forgotten: moved to Agent/Archive).
    for (const row of stale) {
      expect(row.detail).not.toContain("content GONE");
      expect(row.detail).toMatch(/content sha256:/);
    }
  });

  test("recovery after wipe: a journal wipe + reindex re-derives the same stale-source flag", async () => {
    const { journal, git, store, vaultRoot, now, genId } = await makeHarness();

    const s = await store.remember({
      content: "Alice prefers dark mode.",
      entity: "alice",
      reason: "seed",
      session: "s1",
    });
    const d = await store.distill({
      content: "Alice's preferences summary.",
      sources: [s.id],
      reason: "summarize",
      session: "s1",
    });
    await undoTransaction({ git, journal, now, genId }, s.txnId);

    // Wipe: a brand-new, empty journal, rebuilt purely from disk + git.
    const freshJournal = new Journal(openJournal(":memory:"));
    await reindex({ vaultRoot, git, journal: freshJournal, now, genId });

    // The reverted source's file is gone, so reindex never recreates a row
    // for it -- its journal row is now entirely MISSING (not merely
    // "reverted"). The distillation's file still carries the derivation
    // block, so the relation edge is rebuilt from disk regardless.
    expect(freshJournal.getMemory(s.id)).toBeNull();
    expect(freshJournal.getRelationsForMemory(d.id).map((r) => r.source_id)).toEqual([s.id]);

    const result = auditMemories({ journal: freshJournal, vaultRoot, now, genId });

    expect(result.errors).toEqual([]);
    expect(result.pairs).toEqual([{ distillation: d.id, source: s.id, reason: "missing" }]);

    const stale = freshJournal.listConflicts("open").filter((c) => c.kind === "stale-source");
    expect(stale).toHaveLength(1);
    expect(stale[0]!.detail).toContain(`stale-source: ${d.id} cites ${s.id} now missing (content GONE)`);
  });
});
