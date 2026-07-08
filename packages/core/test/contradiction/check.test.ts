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

  // The superseded belief is WORKING (provisional): superseding it is a
  // legitimate intentional update, so the lineage exclusion applies and no
  // conflict is queued. (Superseding a CANONICAL belief is a different case —
  // it must still surface a conflict; see the store-level EVASION test.)
  test("lineage: B supersedes a WORKING A (same entity, differing deadline) -> no conflict queued", () => {
    const { journal, vaultRoot, now, genId } = setup();

    writeNote(vaultRoot, "mem_a.md", "working", { deadline: "2026-08-15" });
    journal.insertMemory(memRow({ id: "mem_a", path: "mem_a.md", entity: "nova", status: "working", supersedes: null }));

    writeNote(vaultRoot, "mem_b.md", "working", { deadline: "2026-09-01" });
    journal.insertMemory(
      memRow({ id: "mem_b", path: "mem_b.md", entity: "nova", status: "working", supersedes: "mem_a" }),
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

  test("value-conflict, different values not swallowed: a DISMISSED conflict does not block a later contradiction on the same pair+fact with a DIFFERENT value", () => {
    const { journal, vaultRoot, now, genId } = setup();

    writeNote(vaultRoot, "mem_a.md", "canonical", { deadline: "2026-08-15" });
    journal.insertMemory(memRow({ id: "mem_a", path: "mem_a.md", entity: "nova", status: "canonical" }));

    writeNote(vaultRoot, "mem_b.md", "scratch", { deadline: "2026-09-01" });
    journal.insertMemory(memRow({ id: "mem_b", path: "mem_b.md", entity: "nova", status: "scratch" }));

    checkContradictions({ journal, vaultRoot, now, genId }, "mem_b");
    const firstOpen = journal.listConflicts("open");
    expect(firstOpen).toHaveLength(1);
    journal.setConflictState(firstOpen[0]!.id, "dismissed");

    // Same pair, same fact_key ("deadline") — but mem_b's value now differs
    // from BOTH the original mem_a value AND the dismissed conflict's mem_b
    // value. Before the fix this collided on (pair_lo, pair_hi, kind,
    // fact_key) and was silently dropped by ON CONFLICT DO NOTHING.
    writeNote(vaultRoot, "mem_b.md", "scratch", { deadline: "2026-12-01" });
    checkContradictions({ journal, vaultRoot, now, genId }, "mem_b");

    const open = journal.listConflicts("open");
    expect(open).toHaveLength(1);
    expect(open[0]!.fact_key).toBe("deadline");
    expect(open[0]!.detail).toContain("2026-12-01");

    // The dismissed row must still be there, untouched.
    const all = journal.listConflicts();
    expect(all).toHaveLength(2);
    expect(all.find((c) => c.id === firstOpen[0]!.id)?.state).toBe("dismissed");
  });

  test("same values dedup preserved: re-checking with the SAME value pair does not create a duplicate row", () => {
    const { journal, vaultRoot, now, genId } = setup();

    writeNote(vaultRoot, "mem_a.md", "canonical", { deadline: "2026-08-15" });
    journal.insertMemory(memRow({ id: "mem_a", path: "mem_a.md", entity: "nova", status: "canonical" }));

    writeNote(vaultRoot, "mem_b.md", "scratch", { deadline: "2026-09-01" });
    journal.insertMemory(memRow({ id: "mem_b", path: "mem_b.md", entity: "nova", status: "scratch" }));

    checkContradictions({ journal, vaultRoot, now, genId }, "mem_b");
    checkContradictions({ journal, vaultRoot, now, genId }, "mem_b");
    checkContradictions({ journal, vaultRoot, now, genId }, "mem_a");

    expect(journal.listConflicts("open")).toHaveLength(1);
  });

  test("negation-conflict parallel: two DIFFERENT negated-statement conflicts are two distinct rows (with distinct value_hash); the identical pair dedups to one", () => {
    const { journal, vaultRoot, now, genId } = setup();

    function writeBody(path: string, ledgerStatus: string, body: string): void {
      const content = matter.stringify(body, { ledger: { status: ledgerStatus } });
      writeFileSync(join(vaultRoot, path), content, "utf8");
    }

    writeBody("mem_a.md", "canonical", "The project is active");
    journal.insertMemory(memRow({ id: "mem_a", path: "mem_a.md", entity: "nova", status: "canonical" }));
    writeBody("mem_b.md", "scratch", "The project is not active");
    journal.insertMemory(memRow({ id: "mem_b", path: "mem_b.md", entity: "nova", status: "scratch" }));

    checkContradictions({ journal, vaultRoot, now, genId }, "mem_b");
    const firstOpen = journal.listConflicts("open");
    expect(firstOpen).toHaveLength(1);
    expect(firstOpen[0]!.value_hash).toBeTruthy();

    // Re-detecting the SAME statement pair (from the other direction) must
    // still dedup to ONE row.
    checkContradictions({ journal, vaultRoot, now, genId }, "mem_a");
    expect(journal.listConflicts("open")).toHaveLength(1);

    // A genuinely DIFFERENT negation-conflict (different subject/object) on
    // the same pair of memories must land as its own row, with its own
    // value_hash — proving the negation-conflict hash isn't a constant.
    writeBody("mem_a.md", "canonical", "The project is active\nThe build is green");
    writeBody("mem_b.md", "scratch", "The project is not active\nThe build is not green");
    checkContradictions({ journal, vaultRoot, now, genId }, "mem_b");

    const open = journal.listConflicts("open");
    expect(open).toHaveLength(2);
    expect(open.map((c) => c.fact_key).sort()).toEqual(["the build::green", "the project::active"]);
    const hashes = new Set(open.map((c) => c.value_hash));
    expect(hashes.size).toBe(2);
  });

  test("detail is built in id-sorted order so each value is attributed to the right memory (checked mem sorts AFTER its peer)", () => {
    const { journal, vaultRoot, now, genId } = setup();

    // Peer id sorts BEFORE the checked memory's id, so memory_a = the peer.
    writeNote(vaultRoot, "mem_aaa.md", "canonical", { deadline: "2026-08-15" });
    journal.insertMemory(memRow({ id: "mem_aaa", path: "mem_aaa.md", entity: "nova", status: "canonical" }));

    writeNote(vaultRoot, "mem_zzz.md", "scratch", { deadline: "2026-09-01" });
    journal.insertMemory(memRow({ id: "mem_zzz", path: "mem_zzz.md", entity: "nova", status: "scratch" }));

    checkContradictions({ journal, vaultRoot, now, genId }, "mem_zzz");
    const open = journal.listConflicts("open");
    expect(open).toHaveLength(1);
    const c = open[0]!;
    // memory_a is the id-sorted low = mem_aaa (deadline 2026-08-15); memory_b is
    // mem_zzz (deadline 2026-09-01). The detail's FIRST value must belong to
    // memory_a. Before the fix, detection ran in checked-mem (zzz) first order,
    // so the detail read "2026-09-01 vs 2026-08-15" while memory_a was mem_aaa —
    // the value attributed to A was actually B's.
    expect(c.memory_a).toBe("mem_aaa");
    expect(c.memory_b).toBe("mem_zzz");
    expect(c.detail).not.toBeNull();
    expect(c.detail!.indexOf("2026-08-15")).toBeLessThan(c.detail!.indexOf("2026-09-01"));
  });
});
