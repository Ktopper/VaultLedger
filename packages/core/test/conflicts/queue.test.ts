import { describe, expect, test } from "vitest";
import { openJournal } from "../../src/journal/db.js";
import { Journal, type ConflictRow, type MemoryRow } from "../../src/journal/journal.js";
import { Conflicts } from "../../src/conflicts/queue.js";

function memRow(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: "mem_1",
    path: "Nova.md",
    entity: "Nova",
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

function conflictRow(overrides: Partial<ConflictRow> = {}): ConflictRow {
  return {
    id: "cf_1",
    memory_a: "mem_a",
    memory_b: "mem_b",
    pair_lo: "mem_a",
    pair_hi: "mem_b",
    kind: "value-conflict",
    fact_key: "deadline",
    entity: "nova",
    detail: 'deadline: "2026-08-15" vs "2026-09-01"',
    created_at: "2026-07-01T00:00:00.000Z",
    state: "open",
    resolved_at: null,
    ...overrides,
  };
}

function makeJournal(): Journal {
  return new Journal(openJournal(":memory:"));
}

describe("Conflicts", () => {
  test("list returns enriched open conflicts with both memory rows attached", () => {
    const j = makeJournal();
    j.insertMemory(memRow({ id: "mem_a", status: "canonical" }));
    j.insertMemory(memRow({ id: "mem_b", status: "working" }));
    j.insertConflict(conflictRow({ id: "cf_1", memory_a: "mem_a", memory_b: "mem_b" }));

    const conflicts = new Conflicts(j);
    const result = conflicts.list("open");

    expect(result).toHaveLength(1);
    expect(result[0]!.row.id).toBe("cf_1");
    expect(result[0]!.memoryA?.id).toBe("mem_a");
    expect(result[0]!.memoryB?.id).toBe("mem_b");
  });

  test("zombie guard: a conflict whose one side is forgotten is excluded from list('open') even though its own state is still 'open'", () => {
    const j = makeJournal();
    j.insertMemory(memRow({ id: "mem_a", status: "canonical" }));
    j.insertMemory(memRow({ id: "mem_b", status: "forgotten" }));
    j.insertConflict(conflictRow({ id: "cf_1", memory_a: "mem_a", memory_b: "mem_b" }));

    const conflicts = new Conflicts(j);
    const result = conflicts.list("open");

    expect(result).toHaveLength(0);
    // The underlying journal row itself is untouched (still 'open') — the
    // filter is a read-time view, not a mutation.
    expect(j.getConflict("cf_1")!.state).toBe("open");
  });

  test("a conflict referencing a missing memory row is also excluded", () => {
    const j = makeJournal();
    j.insertMemory(memRow({ id: "mem_a", status: "canonical" }));
    // mem_b never inserted.
    j.insertConflict(conflictRow({ id: "cf_1", memory_a: "mem_a", memory_b: "mem_b" }));

    const conflicts = new Conflicts(j);
    expect(conflicts.list("open")).toHaveLength(0);
  });

  test("resolve stamps resolved_at and removes the conflict from list('open')", () => {
    const j = makeJournal();
    j.insertMemory(memRow({ id: "mem_a", status: "canonical" }));
    j.insertMemory(memRow({ id: "mem_b", status: "working" }));
    j.insertConflict(conflictRow({ id: "cf_1", memory_a: "mem_a", memory_b: "mem_b" }));

    const conflicts = new Conflicts(j);
    conflicts.resolve("cf_1", "2026-07-05T00:00:00.000Z");

    expect(conflicts.list("open")).toHaveLength(0);
    const enriched = conflicts.get("cf_1")!;
    expect(enriched.row.state).toBe("resolved");
    expect(enriched.row.resolved_at).toBe("2026-07-05T00:00:00.000Z");
  });

  test("dismiss stamps resolved_at and removes the conflict from list('open')", () => {
    const j = makeJournal();
    j.insertMemory(memRow({ id: "mem_a", status: "canonical" }));
    j.insertMemory(memRow({ id: "mem_b", status: "working" }));
    j.insertConflict(conflictRow({ id: "cf_1", memory_a: "mem_a", memory_b: "mem_b" }));

    const conflicts = new Conflicts(j);
    conflicts.dismiss("cf_1", "2026-07-05T00:00:00.000Z");

    expect(conflicts.list("open")).toHaveLength(0);
    const enriched = conflicts.get("cf_1")!;
    expect(enriched.row.state).toBe("dismissed");
    expect(enriched.row.resolved_at).toBe("2026-07-05T00:00:00.000Z");
  });

  test("get returns an enriched conflict with no live-filter applied", () => {
    const j = makeJournal();
    j.insertMemory(memRow({ id: "mem_a", status: "canonical" }));
    j.insertMemory(memRow({ id: "mem_b", status: "forgotten" }));
    j.insertConflict(conflictRow({ id: "cf_1", memory_a: "mem_a", memory_b: "mem_b" }));

    const conflicts = new Conflicts(j);
    const enriched = conflicts.get("cf_1");
    expect(enriched).not.toBeNull();
    expect(enriched!.memoryA?.id).toBe("mem_a");
    expect(enriched!.memoryB?.id).toBe("mem_b");
  });

  test("get returns null for an unknown id", () => {
    const j = makeJournal();
    const conflicts = new Conflicts(j);
    expect(conflicts.get("nope")).toBeNull();
  });
});
