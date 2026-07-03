import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { LedgerGit, formatMessage } from "../../src/broker/git.js";
import { Journal } from "../../src/journal/journal.js";
import { openJournal } from "../../src/journal/db.js";
import { recall } from "../../src/recall/recall.js";
import { reindex, ensureJournal } from "../../src/memory/reindex.js";

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
});
