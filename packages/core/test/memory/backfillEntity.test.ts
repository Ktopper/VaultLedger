import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { LedgerGit, formatMessage } from "../../src/broker/git.js";
import { Journal } from "../../src/journal/journal.js";
import { openJournal } from "../../src/journal/db.js";
import { reindex } from "../../src/memory/reindex.js";
import { Broker } from "../../src/broker/broker.js";
import { backfillEntity } from "../../src/memory/backfillEntity.js";
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

describe("backfillEntity", () => {
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
    vaultRoot: string;
    now: () => string;
    genId: (prefix: string) => string;
  }> {
    const vaultRoot = mkdtempSync(join(tmpdir(), "vl-backfill-"));
    dir = vaultRoot;
    const git = new LedgerGit(vaultRoot);
    await git.init();
    const db = openJournal(":memory:");
    const journal = new Journal(db);
    const { now, genId } = makeClock();
    const broker = new Broker({ vaultRoot, git, journal, manifest: MANIFEST, now, genId });
    return { journal, git, broker, vaultRoot, now, genId };
  }

  /** Write a legacy pre-fix memory note (NO top-level `entity:`) directly to
   * disk + git, simulating a note created before `remember()` started
   * writing entity into top-level frontmatter. */
  async function seedLegacyNoteNoEntity(
    git: LedgerGit,
    vaultRoot: string,
    opts: { id: string; status: string; created: string; body: string },
  ): Promise<string> {
    const relPath = `Agent/Memory/${opts.id}.md`;
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
    return relPath;
  }

  /** Write a note whose FILE already carries a (possibly different)
   * top-level entity than the journal row. */
  async function seedNoteWithEntity(
    git: LedgerGit,
    vaultRoot: string,
    opts: { id: string; status: string; created: string; body: string; entity: string },
  ): Promise<string> {
    const relPath = `Agent/Memory/${opts.id}.md`;
    const noteBody = matter.stringify(opts.body, {
      entity: opts.entity,
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
    return relPath;
  }

  test("backfill: writes the journal's entity into a legacy note's file, and it survives a full rebuild", async () => {
    const { journal, git, broker, vaultRoot, now, genId } = await makeHarness();

    const relPath = await seedLegacyNoteNoEntity(git, vaultRoot, {
      id: "mem_legacy",
      status: "working",
      created: now(),
      body: "A pre-fix memory whose entity lived only in the journal.",
    });
    journal.insertMemory({
      id: "mem_legacy",
      path: relPath,
      entity: "nova",
      status: "working",
      confidence: "medium",
      created: now(),
      source: "s1",
      supersedes: null,
      expires: null,
      last_referenced: null,
    });

    const result = await backfillEntity({ broker, journal, vaultRoot, now, genId });

    expect(result.backfilled).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.mismatched).toEqual([]);
    expect(result.errors).toEqual([]);

    const raw = readFileSync(join(vaultRoot, relPath), "utf8");
    const parsed = matter(raw);
    expect(parsed.data.entity).toBe("nova");

    // A FULL rebuild (fresh, empty journal) must now recover the entity
    // purely from the file, without any journal-only fallback.
    const freshJournal = new Journal(openJournal(":memory:"));
    await reindex({ vaultRoot, git, journal: freshJournal, manifest: MANIFEST, now, genId });
    expect(freshJournal.getMemory("mem_legacy")!.entity).toBe("nova");
  });

  test("skip: a note whose file entity already equals the journal entity is left untouched", async () => {
    const { journal, git, broker, vaultRoot, now, genId } = await makeHarness();

    const relPath = await seedNoteWithEntity(git, vaultRoot, {
      id: "mem_same",
      status: "working",
      created: now(),
      body: "Already self-describing.",
      entity: "nova",
    });
    journal.insertMemory({
      id: "mem_same",
      path: relPath,
      entity: "nova",
      status: "working",
      confidence: "medium",
      created: now(),
      source: "s1",
      supersedes: null,
      expires: null,
      last_referenced: null,
    });

    const before = readFileSync(join(vaultRoot, relPath), "utf8");
    const result = await backfillEntity({ broker, journal, vaultRoot, now, genId });

    expect(result.backfilled).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.mismatched).toEqual([]);

    const after = readFileSync(join(vaultRoot, relPath), "utf8");
    expect(after).toBe(before);
  });

  test("mismatch: a note whose file entity differs from the journal is recorded, not overwritten", async () => {
    const { journal, git, broker, vaultRoot, now, genId } = await makeHarness();

    const relPath = await seedNoteWithEntity(git, vaultRoot, {
      id: "mem_mismatch",
      status: "working",
      created: now(),
      body: "File says bob, journal says nova.",
      entity: "bob",
    });
    journal.insertMemory({
      id: "mem_mismatch",
      path: relPath,
      entity: "nova",
      status: "working",
      confidence: "medium",
      created: now(),
      source: "s1",
      supersedes: null,
      expires: null,
      last_referenced: null,
    });

    const result = await backfillEntity({ broker, journal, vaultRoot, now, genId });

    expect(result.backfilled).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.mismatched).toEqual([
      { path: relPath, fileEntity: "bob", journalEntity: "nova" },
    ]);
    expect(result.errors).toEqual([]);

    // The file must be LEFT UNCHANGED -- not silently overwritten either way.
    const raw = readFileSync(join(vaultRoot, relPath), "utf8");
    const parsed = matter(raw);
    expect(parsed.data.entity).toBe("bob");
  });

  test("error: a journal row pointing at a missing file is recorded non-fatally, and other rows still process", async () => {
    const { journal, git, broker, vaultRoot, now, genId } = await makeHarness();

    // A journal row for a file that was never actually written to disk.
    journal.insertMemory({
      id: "mem_missing",
      path: "Agent/Memory/mem_missing.md",
      entity: "nova",
      status: "working",
      confidence: "medium",
      created: now(),
      source: "s1",
      supersedes: null,
      expires: null,
      last_referenced: null,
    });

    // A perfectly good legacy note alongside it.
    const relPath = await seedLegacyNoteNoEntity(git, vaultRoot, {
      id: "mem_good",
      status: "working",
      created: now(),
      body: "A good note.",
    });
    journal.insertMemory({
      id: "mem_good",
      path: relPath,
      entity: "carol",
      status: "working",
      confidence: "medium",
      created: now(),
      source: "s1",
      supersedes: null,
      expires: null,
      last_referenced: null,
    });

    const result = await backfillEntity({ broker, journal, vaultRoot, now, genId });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.path).toBe("Agent/Memory/mem_missing.md");
    // The good note was still processed and backfilled despite the bad one.
    expect(result.backfilled).toBe(1);

    const raw = readFileSync(join(vaultRoot, relPath), "utf8");
    const parsed = matter(raw);
    expect(parsed.data.entity).toBe("carol");
  });

  test("a memory whose journal row has no entity is not touched at all", async () => {
    const { journal, git, broker, vaultRoot, now, genId } = await makeHarness();

    const relPath = await seedLegacyNoteNoEntity(git, vaultRoot, {
      id: "mem_no_entity",
      status: "working",
      created: now(),
      body: "Neither file nor journal has an entity.",
    });
    journal.insertMemory({
      id: "mem_no_entity",
      path: relPath,
      entity: null,
      status: "working",
      confidence: "medium",
      created: now(),
      source: "s1",
      supersedes: null,
      expires: null,
      last_referenced: null,
    });

    const before = readFileSync(join(vaultRoot, relPath), "utf8");
    const result = await backfillEntity({ broker, journal, vaultRoot, now, genId });

    expect(result.backfilled).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.mismatched).toEqual([]);
    expect(result.errors).toEqual([]);

    const after = readFileSync(join(vaultRoot, relPath), "utf8");
    expect(after).toBe(before);
  });
});
