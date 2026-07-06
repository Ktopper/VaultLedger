import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { openJournal } from "../../src/journal/db.js";
import { Journal, type MemoryRow } from "../../src/journal/journal.js";
import { checkContradictions } from "../../src/contradiction/check.js";

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

function memRow(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: "mem_1",
    path: "mem_1.md",
    entity: "nova",
    status: "canonical",
    confidence: "high",
    created: "2026-07-01T00:00:00.000Z",
    source: "chat",
    supersedes: null,
    expires: null,
    last_referenced: null,
    ...overrides,
  };
}

function writeNote(vaultRoot: string, path: string, ledgerStatus: string, facts: Record<string, string>): void {
  const body = matter.stringify("note body", { ledger: { status: ledgerStatus }, ...facts });
  writeFileSync(join(vaultRoot, path), body, "utf8");
}

describe("checkContradictions", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  function setup(): { journal: Journal; vaultRoot: string; now: () => string; genId: (p: string) => string } {
    const vaultRoot = mkdtempSync(join(tmpdir(), "vl-check-"));
    dir = vaultRoot;
    const journal = new Journal(openJournal(":memory:"));
    const { now, genId } = makeClock();
    return { journal, vaultRoot, now, genId };
  }

  test("scratch-vs-canonical: queues one open value-conflict between A (canonical) and B (scratch)", () => {
    const { journal, vaultRoot, now, genId } = setup();

    writeNote(vaultRoot, "mem_a.md", "canonical", { deadline: "2026-08-15" });
    journal.insertMemory(memRow({ id: "mem_a", path: "mem_a.md", entity: "nova", status: "canonical" }));

    writeNote(vaultRoot, "mem_b.md", "scratch", { deadline: "2026-09-01" });
    journal.insertMemory(memRow({ id: "mem_b", path: "mem_b.md", entity: "nova", status: "scratch" }));

    checkContradictions({ journal, vaultRoot, now, genId }, "mem_b");

    const open = journal.listConflicts("open");
    expect(open).toHaveLength(1);
    const [conflict] = open;
    expect(conflict!.kind).toBe("value-conflict");
    expect(conflict!.fact_key).toBe("deadline");
    expect([conflict!.memory_a, conflict!.memory_b].sort()).toEqual(["mem_a", "mem_b"]);
  });

  test("both-sides convergence: checking B then A for a contradicting pair yields exactly ONE row (order-normalized dedup)", () => {
    const { journal, vaultRoot, now, genId } = setup();

    writeNote(vaultRoot, "mem_a.md", "canonical", { deadline: "2026-08-15" });
    journal.insertMemory(memRow({ id: "mem_a", path: "mem_a.md", entity: "nova", status: "canonical" }));

    writeNote(vaultRoot, "mem_b.md", "canonical", { deadline: "2026-09-01" });
    journal.insertMemory(memRow({ id: "mem_b", path: "mem_b.md", entity: "nova", status: "canonical" }));

    // Run the check from BOTH directions — the (pair_lo, pair_hi, kind,
    // fact_key) unique key must collapse them to a single conflict row.
    checkContradictions({ journal, vaultRoot, now, genId }, "mem_b");
    checkContradictions({ journal, vaultRoot, now, genId }, "mem_a");

    const open = journal.listConflicts("open");
    expect(open).toHaveLength(1);
    expect([open[0]!.memory_a, open[0]!.memory_b].sort()).toEqual(["mem_a", "mem_b"]);
  });

  test("lineage: B supersedes A (same entity, differing deadline) -> no conflict queued", () => {
    const { journal, vaultRoot, now, genId } = setup();

    writeNote(vaultRoot, "mem_a.md", "canonical", { deadline: "2026-08-15" });
    journal.insertMemory(memRow({ id: "mem_a", path: "mem_a.md", entity: "nova", status: "canonical", supersedes: null }));

    writeNote(vaultRoot, "mem_b.md", "canonical", { deadline: "2026-09-01" });
    journal.insertMemory(
      memRow({ id: "mem_b", path: "mem_b.md", entity: "nova", status: "canonical", supersedes: "mem_a" }),
    );

    checkContradictions({ journal, vaultRoot, now, genId }, "mem_b");

    expect(journal.listConflicts("open")).toHaveLength(0);
  });

  test("multi-fact: A/B differ on deadline AND owner -> two conflict rows with distinct fact_key", () => {
    const { journal, vaultRoot, now, genId } = setup();

    writeNote(vaultRoot, "mem_a.md", "canonical", { deadline: "2026-08-15", owner: "Alice" });
    journal.insertMemory(memRow({ id: "mem_a", path: "mem_a.md", entity: "nova", status: "canonical" }));

    writeNote(vaultRoot, "mem_b.md", "scratch", { deadline: "2026-09-01", owner: "Bob" });
    journal.insertMemory(memRow({ id: "mem_b", path: "mem_b.md", entity: "nova", status: "scratch" }));

    checkContradictions({ journal, vaultRoot, now, genId }, "mem_b");

    const open = journal.listConflicts("open");
    expect(open).toHaveLength(2);
    expect(open.map((c) => c.fact_key).sort()).toEqual(["deadline", "owner"]);
  });

  test("non-blocking: a memory whose path points to a nonexistent file does not throw and queues nothing", () => {
    const { journal, vaultRoot, now, genId } = setup();

    journal.insertMemory(memRow({ id: "mem_missing", path: "does-not-exist.md", entity: "nova", status: "canonical" }));

    expect(() => checkContradictions({ journal, vaultRoot, now, genId }, "mem_missing")).not.toThrow();
    expect(journal.listConflicts("open")).toHaveLength(0);
  });

  test("unknown memory id: returns without error", () => {
    const { journal, vaultRoot, now, genId } = setup();
    expect(() => checkContradictions({ journal, vaultRoot, now, genId }, "nope")).not.toThrow();
  });

  test("re-running after the peer's file becomes unreadable does not abort other peers", () => {
    const { journal, vaultRoot, now, genId } = setup();

    writeNote(vaultRoot, "mem_a.md", "canonical", { deadline: "2026-08-15" });
    journal.insertMemory(memRow({ id: "mem_a", path: "mem_a.md", entity: "nova", status: "canonical" }));
    // mem_ghost has a row but no file on disk — should be skipped, not fatal.
    journal.insertMemory(memRow({ id: "mem_ghost", path: "ghost.md", entity: "nova", status: "canonical" }));

    writeNote(vaultRoot, "mem_b.md", "scratch", { deadline: "2026-09-01" });
    journal.insertMemory(memRow({ id: "mem_b", path: "mem_b.md", entity: "nova", status: "scratch" }));

    expect(() => checkContradictions({ journal, vaultRoot, now, genId }, "mem_b")).not.toThrow();
    const open = journal.listConflicts("open");
    expect(open).toHaveLength(1);
    expect([open[0]!.memory_a, open[0]!.memory_b].sort()).toEqual(["mem_a", "mem_b"]);
  });
});
