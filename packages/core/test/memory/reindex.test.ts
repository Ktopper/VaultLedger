import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { LedgerGit, formatMessage } from "../../src/broker/git.js";
import { Journal } from "../../src/journal/journal.js";
import { openJournal } from "../../src/journal/db.js";
import { recall } from "../../src/recall/recall.js";
import { reindex, ensureJournal } from "../../src/memory/reindex.js";
import { Broker } from "../../src/broker/broker.js";
import { MemoryStore } from "../../src/memory/store.js";
import { Approvals } from "../../src/approvals/queue.js";
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

describe("reindex", () => {
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
    const vaultRoot = mkdtempSync(join(tmpdir(), "vl-reindex-"));
    dir = vaultRoot;
    const git = new LedgerGit(vaultRoot);
    await git.init();
    const db = openJournal(":memory:");
    const journal = new Journal(db);
    const { now, genId } = makeClock();
    return { journal, git, vaultRoot, now, genId };
  }

  /** Write a memory note with valid `ledger:` provenance frontmatter directly to
   * disk (bypassing MemoryStore/journal entirely) and commit it, simulating a
   * vault whose journal has been lost/wiped. */
  async function seedMemoryNote(
    git: LedgerGit,
    vaultRoot: string,
    opts: {
      id: string;
      status: string;
      entity: string;
      tags: string[];
      created: string;
      body: string;
    },
  ): Promise<string> {
    const relPath = `Agent/Memory/${opts.id}.md`;
    const noteBody = matter.stringify(opts.body, {
      entity: opts.entity,
      tags: opts.tags,
      ledger: {
        id: opts.id,
        status: opts.status,
        created: opts.created,
        source: "s1",
        reason: "seed",
        confidence: "medium",
        supersedes: null,
        expires: null,
      },
    });
    mkdirSync(join(vaultRoot, "Agent/Memory"), { recursive: true });
    writeFileSync(join(vaultRoot, relPath), noteBody, "utf8");
    const sha = await git.commitFile(
      relPath,
      formatMessage({ op: "create", basename: `${opts.id}.md`, memoryId: opts.id, session: "s1" }),
    );
    return sha;
  }

  test("rebuilds memories and transactions from disk + git when the journal is empty", async () => {
    const { journal, git, vaultRoot, now } = await makeHarness();

    const shaA = await seedMemoryNote(git, vaultRoot, {
      id: "mem_a",
      status: "working",
      entity: "alice",
      tags: ["preferences", "ui"],
      created: now(),
      body: "Alice prefers dark mode.",
    });
    const shaB = await seedMemoryNote(git, vaultRoot, {
      id: "mem_b",
      status: "scratch",
      entity: "bob",
      tags: ["projects"],
      created: now(),
      body: "Bob is working on the launch.",
    });

    expect(journal.getMemory("mem_a")).toBeNull();
    expect(journal.hasCommit(shaA)).toBe(false);

    const genId2 = (() => {
      let counter = 0;
      return (prefix: string) => {
        counter += 1;
        return `${prefix}_reindex_${counter}`;
      };
    })();

    const result = await reindex({ vaultRoot, git, journal, now, genId: genId2 });

    expect(result.memories).toBe(2);
    expect(result.transactions).toBeGreaterThanOrEqual(2);

    expect(journal.hasCommit(shaA)).toBe(true);
    expect(journal.hasCommit(shaB)).toBe(true);

    const memA = journal.getMemory("mem_a");
    expect(memA).not.toBeNull();
    expect(memA!.status).toBe("working");
    expect(memA!.entity).toBe("alice");
    expect(memA!.path).toBe("Agent/Memory/mem_a.md");
    expect(journal.getTags("mem_a").sort()).toEqual(["preferences", "ui"]);

    const memB = journal.getMemory("mem_b");
    expect(memB).not.toBeNull();
    expect(memB!.status).toBe("scratch");
    expect(memB!.entity).toBe("bob");

    const recalled = recall(journal, {}, now).map((r) => r.id);
    expect(recalled).toContain("mem_a");
    expect(recalled).toContain("mem_b");
  });

  test("is idempotent: a second run upserts the same ids and inserts no duplicate transactions", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();

    await seedMemoryNote(git, vaultRoot, {
      id: "mem_x",
      status: "working",
      entity: "carol",
      tags: ["tag1"],
      created: now(),
      body: "Carol likes tea.",
    });

    const first = await reindex({ vaultRoot, git, journal, now, genId });
    expect(first.memories).toBe(1);
    expect(first.transactions).toBeGreaterThanOrEqual(1);

    const second = await reindex({ vaultRoot, git, journal, now, genId });
    expect(second.memories).toBe(1);
    // No new commits appeared since the first run, so nothing new to insert.
    expect(second.transactions).toBe(0);

    // Exactly one memory row for mem_x — no duplicate insert.
    expect(journal.queryMemories({}).filter((m) => m.id === "mem_x")).toHaveLength(1);
    // Tags not duplicated across the two runs.
    expect(journal.getTags("mem_x")).toEqual(["tag1"]);
  });

  test("ensureJournal reindexes an empty journal and reports true; a populated journal reports false", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();

    await seedMemoryNote(git, vaultRoot, {
      id: "mem_heal",
      status: "working",
      entity: "dana",
      tags: [],
      created: now(),
      body: "Dana's note.",
    });

    const healed = await ensureJournal({ vaultRoot, git, journal, now, genId });
    expect(healed).toBe(true);
    expect(journal.getMemory("mem_heal")).not.toBeNull();

    const second = await ensureJournal({ vaultRoot, git, journal, now, genId });
    expect(second).toBe(false);
  });

  test("a canonical promotion survives a reindex into a fresh empty journal (status is durable in the file)", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();
    const broker = new Broker({ vaultRoot, git, journal, manifest: MANIFEST, now, genId });
    const store = new MemoryStore({ broker, journal, now, genId, vaultRoot });
    const approvals = new Approvals({ broker, store, journal, now, vaultRoot, genId });

    const { id } = await store.remember({ content: "canonical truth", reason: "seed", session: "s1" });
    await store.promote({ id, target_status: "working", reason: "confirmed", session: "s1" });
    const promotion = await store.promote({ id, target_status: "canonical", reason: "well established", session: "s1" });
    await approvals.approve(promotion.approvalId!);
    expect(journal.getMemory(id)!.status).toBe("canonical");

    // Simulate total journal loss: rebuild a fresh empty journal from disk + git.
    const freshJournal = new Journal(openJournal(":memory:"));
    expect(freshJournal.getMemory(id)).toBeNull();

    const result = await reindex({ vaultRoot, git, journal: freshJournal, now, genId });
    expect(result.memories).toBe(1);
    // The canonical status was recovered purely from the file frontmatter.
    expect(freshJournal.getMemory(id)!.status).toBe("canonical");
  });

  test("reindex skips a corrupted note and records it in `skipped`, without throwing", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();

    // One valid memory note...
    await seedMemoryNote(git, vaultRoot, {
      id: "mem_good",
      status: "working",
      entity: "eve",
      tags: [],
      created: now(),
      body: "A good note.",
    });

    // ...and one file with broken YAML frontmatter that gray-matter cannot parse.
    mkdirSync(join(vaultRoot, "Agent/Memory"), { recursive: true });
    const badRel = "Agent/Memory/broken.md";
    writeFileSync(
      join(vaultRoot, badRel),
      "---\nledger:\n  id: mem_bad\n  status: working\n  created: [unclosed\n---\n\nbody\n",
      "utf8",
    );
    await git.commitFile(badRel, formatMessage({ op: "create", basename: "broken.md", session: "s1" }));

    const result = await reindex({ vaultRoot, git, journal, now, genId });
    expect(result.memories).toBe(1);
    expect(result.skipped).toContain(badRel);
    expect(journal.getMemory("mem_good")).not.toBeNull();
  });

  test("reindex records a duplicate ledger.id in `conflicts` and keeps the first occurrence", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();

    mkdirSync(join(vaultRoot, "Agent/Memory"), { recursive: true });
    const noteFor = (entity: string) =>
      matter.stringify(`body of ${entity}`, {
        entity,
        ledger: {
          id: "mem_dup",
          status: "working",
          created: now(),
          source: "s1",
          reason: "seed",
          confidence: "medium",
          supersedes: null,
          expires: null,
        },
      });

    // "aaa.md" sorts before "zzz.md"; the walk visits aaa first, so it wins.
    writeFileSync(join(vaultRoot, "Agent/Memory/aaa.md"), noteFor("alice"), "utf8");
    writeFileSync(join(vaultRoot, "Agent/Memory/zzz.md"), noteFor("zoe"), "utf8");
    await git.commitFile("Agent/Memory/aaa.md", formatMessage({ op: "create", basename: "aaa.md", session: "s1" }));
    await git.commitFile("Agent/Memory/zzz.md", formatMessage({ op: "create", basename: "zzz.md", session: "s1" }));

    const result = await reindex({ vaultRoot, git, journal, now, genId });
    expect(result.memories).toBe(1);
    expect(result.conflicts.length).toBe(1);
    // Exactly one row for mem_dup, and it kept the first-walked file's entity.
    expect(journal.queryMemories({}).filter((m) => m.id === "mem_dup")).toHaveLength(1);
    expect(journal.getMemory("mem_dup")!.entity).toBe("alice");
  });

  // -------------------------------------------------------------------
  // reindex tripwire (v0.3a): flag, never refuse, an out-of-broker
  // canonical elevation caught at recovery time (defense-in-depth for the
  // ledger-block guard closed in Broker.applyRevise -- this catches an edit
  // made directly to the vault file, outside the broker entirely).
  // -------------------------------------------------------------------

  test("incremental reindex flags an out-of-band canonical elevation, but still adopts it", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();
    const broker = new Broker({ vaultRoot, git, journal, manifest: MANIFEST, now, genId });
    const store = new MemoryStore({ broker, journal, now, genId, vaultRoot });

    const { id, path } = await store.remember({ content: "x", reason: "seed", session: "s1" });
    await store.promote({ id, target_status: "working", reason: "confirmed", session: "s1" });
    expect(journal.getMemory(id)!.status).toBe("working");

    // Out-of-band edit: the file is patched directly (NOT through the
    // broker), flipping ledger.status to canonical without ever going
    // through the promote/approval gate.
    const abs = join(vaultRoot, path);
    const parsed = matter(readFileSync(abs, "utf8"));
    const currentLedger = parsed.data.ledger as Record<string, unknown>;
    const tampered = matter.stringify(parsed.content, {
      ...parsed.data,
      ledger: { ...currentLedger, status: "canonical" },
    });
    writeFileSync(abs, tampered, "utf8");

    // The journal row here is the SAME (non-empty, pre-existing) journal
    // used above -- an incremental reindex, not a fresh rebuild.
    const result = await reindex({ vaultRoot, git, journal, now, genId });

    expect(result.elevatedToCanonical).toContain(path);
    // Reindex must NEVER refuse to adopt a status (the journal is
    // disposable/rebuildable) -- it flags loudly and still adopts.
    expect(journal.getMemory(id)!.status).toBe("canonical");
  });

  test("an already-canonical row that stays canonical is NOT flagged", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();
    const broker = new Broker({ vaultRoot, git, journal, manifest: MANIFEST, now, genId });
    const store = new MemoryStore({ broker, journal, now, genId, vaultRoot });
    const approvals = new Approvals({ broker, store, journal, now, vaultRoot, genId });

    const { id } = await store.remember({ content: "y", reason: "seed", session: "s1" });
    await store.promote({ id, target_status: "working", reason: "confirmed", session: "s1" });
    const promotion = await store.promote({
      id,
      target_status: "canonical",
      reason: "well established",
      session: "s1",
    });
    await approvals.approve(promotion.approvalId!);
    expect(journal.getMemory(id)!.status).toBe("canonical");

    // Incremental reindex over the SAME journal: the row was already
    // canonical before this run, so it must not be (re-)flagged.
    const result = await reindex({ vaultRoot, git, journal, now, genId });
    expect(result.elevatedToCanonical).toEqual([]);
  });

  test("a fresh full rebuild (empty journal) is NOT flagged for a canonical file", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();

    await seedMemoryNote(git, vaultRoot, {
      id: "mem_fresh_canon",
      status: "canonical",
      entity: "frank",
      tags: [],
      created: now(),
      body: "Already canonical from the start.",
    });

    // Journal starts empty -- there is no prior row to compare against, so a
    // full rebuild must never be noisy about a canonical file.
    const result = await reindex({ vaultRoot, git, journal, now, genId });
    expect(result.memories).toBe(1);
    expect(result.elevatedToCanonical).toEqual([]);
  });

  // entity-durability (v0.3a): a "legacy" note whose file predates
  // entity-in-frontmatter carries no top-level `entity:` field, so it parses
  // with entity=null. On an INCREMENTAL reindex the journal row's real entity
  // must be preserved, not nulled -- otherwise a routine reindex silently
  // empties every same-entity contradiction comparison set.
  // ---------------------------------------------------------------------
  async function seedLegacyNoteNoEntity(
    git: LedgerGit,
    vaultRoot: string,
    opts: { id: string; status: string; created: string; body: string },
  ): Promise<void> {
    const relPath = `Agent/Memory/${opts.id}.md`;
    // NOTE: no top-level `entity:` -- the pre-fix note shape.
    const noteBody = matter.stringify(opts.body, {
      ledger: {
        id: opts.id,
        status: opts.status,
        created: opts.created,
        source: "s1",
        reason: "seed",
        confidence: "medium",
        supersedes: null,
        expires: null,
      },
    });
    mkdirSync(join(vaultRoot, "Agent/Memory"), { recursive: true });
    writeFileSync(join(vaultRoot, relPath), noteBody, "utf8");
    await git.commitFile(
      relPath,
      formatMessage({ op: "create", basename: `${opts.id}.md`, memoryId: opts.id, session: "s1" }),
    );
  }

  test("incremental reindex preserves a journal-only entity when the file lacks a top-level entity", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();

    await seedLegacyNoteNoEntity(git, vaultRoot, {
      id: "mem_legacy",
      status: "working",
      created: now(),
      body: "A pre-fix memory whose entity lived only in the journal.",
    });
    // The journal already holds the real entity (as it would after remember()).
    journal.insertMemory({
      id: "mem_legacy",
      path: "Agent/Memory/mem_legacy.md",
      entity: "nova",
      status: "working",
      confidence: "medium",
      created: now(),
      source: "s1",
      supersedes: null,
      expires: null,
      last_referenced: null,
    });

    await reindex({ vaultRoot, git, journal, now, genId });

    // The file declares no entity, but the incremental reindex must NOT wipe
    // the journal's known entity.
    expect(journal.getMemory("mem_legacy")!.entity).toBe("nova");
  });

  test("round-trip: a memory remembered by the store survives a FULL journal rebuild with its entity intact", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();
    const broker = new Broker({ vaultRoot, git, journal, manifest: MANIFEST, now, genId });
    const store = new MemoryStore({ broker, journal, now, genId, vaultRoot });

    const { id } = await store.remember({
      content: "Nova's deadline is 2026-08-15.",
      entity: "nova",
      tags: ["deadline"],
      reason: "seed",
      session: "s1",
    });
    expect(journal.getMemory(id)!.entity).toBe("nova");

    // Total journal loss -> rebuild from disk + git into a fresh empty journal.
    const freshJournal = new Journal(openJournal(":memory:"));
    await reindex({ vaultRoot, git, journal: freshJournal, now, genId });

    // entity (and tags) recovered PURELY from the file, because remember() now
    // writes them into the note's top-level frontmatter.
    expect(freshJournal.getMemory(id)!.entity).toBe("nova");
    expect(freshJournal.getTags(id)).toEqual(["deadline"]);
  });

  test("a full rebuild (empty journal) cannot recover a legacy note's journal-only entity -> null (documented gap)", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();

    await seedLegacyNoteNoEntity(git, vaultRoot, {
      id: "mem_legacy2",
      status: "working",
      created: now(),
      body: "No entity in the file; empty journal has nothing to fall back on.",
    });

    // Journal is empty -- no prior row -> entity genuinely unrecoverable. This
    // locks the documented residual: legacy notes need the entity backfilled
    // into their files (or to be re-remembered) to survive a full rebuild.
    await reindex({ vaultRoot, git, journal, now, genId });
    expect(journal.getMemory("mem_legacy2")!.entity).toBeNull();
  });

  // -------------------------------------------------------------------
  // v0.3b: `memory_relations` rebuild from `ledger.derivation.sources`.
  // -------------------------------------------------------------------

  /** Write a distillation note carrying `ledger.derivation.sources` directly
   * to disk and commit it, mirroring seedMemoryNote but with the v0.3b
   * derivation block added. */
  async function seedDistillationNote(
    git: LedgerGit,
    vaultRoot: string,
    opts: { id: string; sources: string[]; created: string },
  ): Promise<void> {
    const relPath = `Agent/Memory/${opts.id}.md`;
    const noteBody = matter.stringify("Distilled summary.", {
      ledger: {
        id: opts.id,
        status: "canonical",
        created: opts.created,
        source: "s1",
        reason: "distill",
        confidence: "medium",
        supersedes: null,
        expires: null,
        derivation: { kind: "distilled", sources: opts.sources },
      },
    });
    mkdirSync(join(vaultRoot, "Agent/Memory"), { recursive: true });
    writeFileSync(join(vaultRoot, relPath), noteBody, "utf8");
    await git.commitFile(
      relPath,
      formatMessage({ op: "create", basename: `${opts.id}.md`, memoryId: opts.id, session: "s1" }),
    );
  }

  test("reindex into a FRESH empty journal rebuilds memory_relations edges purely from ledger.derivation.sources", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();

    await seedDistillationNote(git, vaultRoot, {
      id: "mem_distilled",
      sources: ["mem_a", "mem_b"],
      created: now(),
    });

    const result = await reindex({ vaultRoot, git, journal, now, genId });
    expect(result.memories).toBe(1);

    const edges = journal.getRelationsForMemory("mem_distilled");
    expect(edges.map((e) => e.source_id).sort()).toEqual(["mem_a", "mem_b"]);
    expect(edges.every((e) => e.kind === "distilled")).toBe(true);
  });

  test("reindex is idempotent across re-runs: a second pass does not duplicate memory_relations edges", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();

    await seedDistillationNote(git, vaultRoot, {
      id: "mem_distilled2",
      sources: ["mem_x"],
      created: now(),
    });

    await reindex({ vaultRoot, git, journal, now, genId });
    await reindex({ vaultRoot, git, journal, now, genId });

    expect(journal.getRelationsForMemory("mem_distilled2")).toHaveLength(1);
  });

  test("reindex clears stale memory_relations edges for a note whose file no longer declares a derivation block", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();

    // A plain memory note (no derivation block) on disk...
    await seedMemoryNote(git, vaultRoot, {
      id: "mem_plain",
      status: "canonical",
      entity: "alice",
      tags: [],
      created: now(),
      body: "A plain belief with no derivation.",
    });
    // ...but a stale relation row survives in the journal (e.g. it once was a
    // distillation whose derivation block was later removed).
    journal.insertRelation({ memory_id: "mem_plain", source_id: "mem_ghost", kind: "distilled" });
    expect(journal.getRelationsForMemory("mem_plain")).toHaveLength(1);

    await reindex({ vaultRoot, git, journal, now, genId });

    // The edge set must now exactly track the file: no derivation → no edges.
    expect(journal.getRelationsForMemory("mem_plain")).toHaveLength(0);
  });
});
