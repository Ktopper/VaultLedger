import { describe, expect, test } from "vitest";
import { openJournal } from "../../src/journal/db.js";
import { Journal } from "../../src/journal/journal.js";
import type { MemoryRow } from "../../src/journal/journal.js";
import { DefaultEntityMatcher, lineageIds } from "../../src/contradiction/matcher.js";

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

function makeJournal(): Journal {
  return new Journal(openJournal(":memory:"));
}

describe("DefaultEntityMatcher.comparisonSet", () => {
  const matcher = new DefaultEntityMatcher();

  test("returns canonical/working same-entity peers, excluding scratch/forgotten/reverted and self", () => {
    const j = makeJournal();
    j.insertMemory(memRow({ id: "mem_1", status: "canonical" }));
    j.insertMemory(memRow({ id: "mem_2", status: "working" }));
    j.insertMemory(memRow({ id: "mem_3", status: "scratch" }));
    j.insertMemory(memRow({ id: "mem_4", status: "forgotten" }));
    j.insertMemory(memRow({ id: "mem_5", status: "reverted" }));

    const mem = j.getMemory("mem_1")!;
    const result = matcher.comparisonSet(mem, j);
    expect(result.map((m) => m.id).sort()).toEqual(["mem_2"]);
  });

  // Uses WORKING memories: the lineage exclusion still fully applies to
  // provisional beliefs. (Canonical lineage members are deliberately NOT hidden
  // — see the "canonical exception" tests below.)
  test("lineage (working): B supersedes A -> neither includes the other", () => {
    const j = makeJournal();
    j.insertMemory(memRow({ id: "mem_a", status: "working", supersedes: null }));
    j.insertMemory(memRow({ id: "mem_b", status: "working", supersedes: "mem_a" }));

    const a = j.getMemory("mem_a")!;
    const b = j.getMemory("mem_b")!;

    expect(matcher.comparisonSet(b, j).map((m) => m.id)).not.toContain("mem_a");
    expect(matcher.comparisonSet(a, j).map((m) => m.id)).not.toContain("mem_b");
  });

  test("transitive lineage (working): A<-B<-C -> none of the three include each other", () => {
    const j = makeJournal();
    j.insertMemory(memRow({ id: "mem_a", status: "working", supersedes: null }));
    j.insertMemory(memRow({ id: "mem_b", status: "working", supersedes: "mem_a" }));
    j.insertMemory(memRow({ id: "mem_c", status: "working", supersedes: "mem_b" }));
    // An unrelated same-entity peer that should still show up for all three.
    j.insertMemory(memRow({ id: "mem_d", status: "canonical", supersedes: null }));

    const a = j.getMemory("mem_a")!;
    const b = j.getMemory("mem_b")!;
    const c = j.getMemory("mem_c")!;

    const resultA = matcher.comparisonSet(a, j).map((m) => m.id).sort();
    const resultB = matcher.comparisonSet(b, j).map((m) => m.id).sort();
    const resultC = matcher.comparisonSet(c, j).map((m) => m.id).sort();

    expect(resultA).toEqual(["mem_d"]);
    expect(resultB).toEqual(["mem_d"]);
    expect(resultC).toEqual(["mem_d"]);
  });

  test("entity matching is case/whitespace-folded: 'Nova', 'nova', ' nova ' all compare", () => {
    const j = makeJournal();
    j.insertMemory(memRow({ id: "mem_1", entity: "Nova", status: "canonical" }));
    j.insertMemory(memRow({ id: "mem_2", entity: "nova", status: "canonical" }));
    j.insertMemory(memRow({ id: "mem_3", entity: " nova ", status: "canonical" }));
    // A genuinely different entity is still excluded.
    j.insertMemory(memRow({ id: "mem_4", entity: "Orion", status: "canonical" }));

    const mem = j.getMemory("mem_1")!;
    const result = matcher.comparisonSet(mem, j).map((m) => m.id).sort();
    expect(result).toEqual(["mem_2", "mem_3"]);
  });

  test("canonical exception: a lineage-linked CANONICAL candidate IS still returned (supersedes must not hide a live canonical belief)", () => {
    const j = makeJournal();
    j.insertMemory(memRow({ id: "mem_a", status: "canonical", supersedes: null }));
    j.insertMemory(memRow({ id: "mem_b", status: "working", supersedes: "mem_a" }));

    const b = j.getMemory("mem_b")!;
    expect(matcher.comparisonSet(b, j).map((m) => m.id)).toContain("mem_a");
  });

  test("canonical exception is scoped: a lineage-linked WORKING candidate is NOT returned", () => {
    const j = makeJournal();
    j.insertMemory(memRow({ id: "mem_a", status: "working", supersedes: null }));
    j.insertMemory(memRow({ id: "mem_b", status: "working", supersedes: "mem_a" }));

    const b = j.getMemory("mem_b")!;
    expect(matcher.comparisonSet(b, j).map((m) => m.id)).not.toContain("mem_a");
  });

  test("different-entity memories are excluded; null-entity mem returns []", () => {
    const j = makeJournal();
    j.insertMemory(memRow({ id: "mem_1", entity: "Nova", status: "canonical" }));
    j.insertMemory(memRow({ id: "mem_2", entity: "Orion", status: "canonical" }));
    j.insertMemory(memRow({ id: "mem_3", entity: null, status: "canonical" }));

    const nova = j.getMemory("mem_1")!;
    expect(matcher.comparisonSet(nova, j).map((m) => m.id)).toEqual([]);

    const noEntity = j.getMemory("mem_3")!;
    expect(matcher.comparisonSet(noEntity, j)).toEqual([]);
  });
});

describe("lineageIds", () => {
  test("transitive closure in both directions", () => {
    const j = makeJournal();
    j.insertMemory(memRow({ id: "mem_a", status: "canonical", supersedes: null }));
    j.insertMemory(memRow({ id: "mem_b", status: "canonical", supersedes: "mem_a" }));
    j.insertMemory(memRow({ id: "mem_c", status: "canonical", supersedes: "mem_b" }));

    const a = j.getMemory("mem_a")!;
    const ids = lineageIds(a, j);
    expect([...ids].sort()).toEqual(["mem_a", "mem_b", "mem_c"]);
  });
});
