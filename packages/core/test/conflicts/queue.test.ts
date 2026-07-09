import { describe, expect, test } from "vitest";
import { openJournal } from "../../src/journal/db.js";
import { Journal, type ConflictRow, type MemoryRow } from "../../src/journal/journal.js";
import { Conflicts } from "../../src/conflicts/queue.js";
import { BrokerError } from "../../src/errors.js";
import { flagStaleSource } from "../../src/contradiction/staleness.js";

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
    value_hash: "sha256:vh_1",
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

  test("resolve on an already-dismissed conflict is rejected (typed error), not silently overwritten", () => {
    const j = makeJournal();
    j.insertMemory(memRow({ id: "mem_a", status: "canonical" }));
    j.insertMemory(memRow({ id: "mem_b", status: "working" }));
    j.insertConflict(conflictRow({ id: "cf_1" }));

    const conflicts = new Conflicts(j);
    conflicts.dismiss("cf_1", "2026-07-05T00:00:00.000Z");

    expect(() => conflicts.resolve("cf_1", "2026-07-06T00:00:00.000Z")).toThrow(BrokerError);
    try {
      conflicts.resolve("cf_1", "2026-07-06T00:00:00.000Z");
      throw new Error("expected resolve to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrokerError);
      expect((e as BrokerError).code).toBe("ALREADY_CLOSED");
    }

    // The stored state must still be 'dismissed' -- the rejected resolve()
    // call must NOT have silently flipped it.
    const enriched = conflicts.get("cf_1")!;
    expect(enriched.row.state).toBe("dismissed");
    expect(enriched.row.resolved_at).toBe("2026-07-05T00:00:00.000Z");
  });

  test("dismiss on an already-resolved conflict is rejected (typed error), not silently overwritten", () => {
    const j = makeJournal();
    j.insertMemory(memRow({ id: "mem_a", status: "canonical" }));
    j.insertMemory(memRow({ id: "mem_b", status: "working" }));
    j.insertConflict(conflictRow({ id: "cf_1" }));

    const conflicts = new Conflicts(j);
    conflicts.resolve("cf_1", "2026-07-05T00:00:00.000Z");

    expect(() => conflicts.dismiss("cf_1", "2026-07-06T00:00:00.000Z")).toThrow(BrokerError);

    const enriched = conflicts.get("cf_1")!;
    expect(enriched.row.state).toBe("resolved");
    expect(enriched.row.resolved_at).toBe("2026-07-05T00:00:00.000Z");
  });

  test("resolve on an unknown id signals NOT_FOUND, consistent with get() returning null", () => {
    const j = makeJournal();
    const conflicts = new Conflicts(j);
    expect(() => conflicts.resolve("cf_nope", "2026-07-05T00:00:00.000Z")).toThrow(BrokerError);
    try {
      conflicts.resolve("cf_nope", "2026-07-05T00:00:00.000Z");
    } catch (e) {
      expect((e as BrokerError).code).toBe("NOT_FOUND");
    }
  });

  test("dismiss on an unknown id signals NOT_FOUND", () => {
    const j = makeJournal();
    const conflicts = new Conflicts(j);
    try {
      conflicts.dismiss("cf_nope", "2026-07-05T00:00:00.000Z");
      throw new Error("expected dismiss to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrokerError);
      expect((e as BrokerError).code).toBe("NOT_FOUND");
    }
  });

  test("resolving a genuinely open conflict still works (happy path unchanged)", () => {
    const j = makeJournal();
    j.insertMemory(memRow({ id: "mem_a", status: "canonical" }));
    j.insertMemory(memRow({ id: "mem_b", status: "working" }));
    j.insertConflict(conflictRow({ id: "cf_1" }));

    const conflicts = new Conflicts(j);
    expect(() => conflicts.resolve("cf_1", "2026-07-05T00:00:00.000Z")).not.toThrow();
    expect(conflicts.get("cf_1")!.row.state).toBe("resolved");
  });

  // ---------------------------------------------------------------------
  // stale-source kind: kind-aware both-sides-live filter
  // ---------------------------------------------------------------------

  describe("stale-source liveness (per-pair distillation role, not position)", () => {
    // distillationId < sourceId alphabetically.
    test("D<S ordering: kept while distillation D is live even though source S is dead; filtered once D dies too", () => {
      const j = makeJournal();
      const { now, genId } = makeClock();
      const distillationId = "mem_a_d";
      const sourceId = "mem_b_s";
      expect(distillationId < sourceId).toBe(true);

      j.insertMemory(memRow({ id: distillationId, status: "working" }));
      j.insertMemory(memRow({ id: sourceId, status: "retired" }));
      j.insertRelation({ memory_id: distillationId, source_id: sourceId, kind: "distilled" });

      flagStaleSource(
        j,
        { distillationId, sourceId, sourceStatus: "retired", contentId: "sha256:abc", entity: "nova" },
        now,
        genId,
      );

      const conflicts = new Conflicts(j);
      // Source is dead (retired) -- ordinary both-sides-live logic would drop
      // this, but stale-source only cares about the distillation side.
      expect(conflicts.list("open")).toHaveLength(1);

      j.setMemoryStatus(distillationId, "forgotten");
      expect(conflicts.list("open")).toHaveLength(0);
    });

    // distillationId > sourceId alphabetically -- proves the filter isn't
    // reading memory_a/pair_lo position, only the actual edge.
    test("D>S ordering: same behavior, position-independent", () => {
      const j = makeJournal();
      const { now, genId } = makeClock();
      const distillationId = "mem_z_d";
      const sourceId = "mem_a_s";
      expect(distillationId > sourceId).toBe(true);

      j.insertMemory(memRow({ id: distillationId, status: "working" }));
      j.insertMemory(memRow({ id: sourceId, status: "retired" }));
      j.insertRelation({ memory_id: distillationId, source_id: sourceId, kind: "distilled" });

      flagStaleSource(
        j,
        { distillationId, sourceId, sourceStatus: "retired", contentId: "sha256:abc", entity: "nova" },
        now,
        genId,
      );

      const conflicts = new Conflicts(j);
      expect(conflicts.list("open")).toHaveLength(1);

      j.setMemoryStatus(distillationId, "forgotten");
      expect(conflicts.list("open")).toHaveLength(0);
    });

    // Distillation chain: D2 cites D1, D1 cites S. A stale-source flag on the
    // {D2, D1} pair must resolve D2 (not D1) as "the distillation" for THIS
    // pair, via the D2->D1 edge specifically -- both D1 and D2 are
    // memory_id for SOME edge, so a per-memory (not per-pair) test would be
    // ambiguous.
    describe("distillation chain (D2 cites D1, D1 cites S)", () => {
      test("D2<D1 ordering", () => {
        const j = makeJournal();
        const { now, genId } = makeClock();
        const d2 = "mem_a_d2";
        const d1 = "mem_b_d1";
        const s = "mem_c_s";
        expect(d2 < d1).toBe(true);

        j.insertMemory(memRow({ id: d2, status: "working" }));
        j.insertMemory(memRow({ id: d1, status: "working" }));
        j.insertMemory(memRow({ id: s, status: "retired" }));
        j.insertRelation({ memory_id: d2, source_id: d1, kind: "distilled" });
        j.insertRelation({ memory_id: d1, source_id: s, kind: "distilled" });

        flagStaleSource(
          j,
          { distillationId: d2, sourceId: d1, sourceStatus: "retired", contentId: "sha256:abc", entity: "nova" },
          now,
          genId,
        );

        const conflicts = new Conflicts(j);
        // D2 (the per-pair distillation for {D2,D1}) is live -> kept, even
        // though D1 -- also a distillation, just not for THIS pair -- would
        // be irrelevant to check.
        expect(conflicts.list("open")).toHaveLength(1);

        j.setMemoryStatus(d2, "forgotten");
        expect(conflicts.list("open")).toHaveLength(0);
      });

      test("D2>D1 ordering", () => {
        const j = makeJournal();
        const { now, genId } = makeClock();
        const d2 = "mem_z_d2";
        const d1 = "mem_a_d1";
        const s = "mem_b_s";
        expect(d2 > d1).toBe(true);

        j.insertMemory(memRow({ id: d2, status: "working" }));
        j.insertMemory(memRow({ id: d1, status: "working" }));
        j.insertMemory(memRow({ id: s, status: "retired" }));
        j.insertRelation({ memory_id: d2, source_id: d1, kind: "distilled" });
        j.insertRelation({ memory_id: d1, source_id: s, kind: "distilled" });

        flagStaleSource(
          j,
          { distillationId: d2, sourceId: d1, sourceStatus: "retired", contentId: "sha256:abc", entity: "nova" },
          now,
          genId,
        );

        const conflicts = new Conflicts(j);
        expect(conflicts.list("open")).toHaveLength(1);

        j.setMemoryStatus(d2, "forgotten");
        expect(conflicts.list("open")).toHaveLength(0);
      });
    });

    test("dedup: identical flagStaleSource calls collapse to one row; a different sourceStatus (or contentId) makes a second row", () => {
      const j = makeJournal();
      const { now, genId } = makeClock();
      const distillationId = "mem_a_d";
      const sourceId = "mem_b_s";

      j.insertMemory(memRow({ id: distillationId, status: "working" }));
      j.insertMemory(memRow({ id: sourceId, status: "retired" }));
      j.insertRelation({ memory_id: distillationId, source_id: sourceId, kind: "distilled" });

      flagStaleSource(
        j,
        { distillationId, sourceId, sourceStatus: "retired", contentId: "sha256:abc", entity: "nova" },
        now,
        genId,
      );
      flagStaleSource(
        j,
        { distillationId, sourceId, sourceStatus: "retired", contentId: "sha256:abc", entity: "nova" },
        now,
        genId,
      );

      expect(j.listConflicts().filter((r) => r.kind === "stale-source")).toHaveLength(1);

      flagStaleSource(
        j,
        { distillationId, sourceId, sourceStatus: "forgotten", contentId: "sha256:abc", entity: "nova" },
        now,
        genId,
      );

      expect(j.listConflicts().filter((r) => r.kind === "stale-source")).toHaveLength(2);

      flagStaleSource(
        j,
        { distillationId, sourceId, sourceStatus: "forgotten", contentId: "sha256:def", entity: "nova" },
        now,
        genId,
      );

      expect(j.listConflicts().filter((r) => r.kind === "stale-source")).toHaveLength(3);
    });
  });
});
