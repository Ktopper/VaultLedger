import { describe, expect, test } from "vitest";
import { openJournal } from "../../src/journal/db.js";
import { Journal, type MemoryRow } from "../../src/journal/journal.js";
import { recall } from "../../src/recall/recall.js";

function seed(journal: Journal, row: MemoryRow, tags: string[] = []): void {
  journal.insertMemory(row);
  if (tags.length > 0) journal.addTags(row.id, tags);
}

function baseRow(overrides: Partial<MemoryRow> & { id: string }): MemoryRow {
  return {
    path: `Agent/Memory/${overrides.id}.md`,
    entity: null,
    status: "working",
    confidence: "medium",
    created: "2026-01-01T00:00:00.000Z",
    source: "s1",
    supersedes: null,
    expires: null,
    last_referenced: null,
    ...overrides,
  };
}

describe("recall", () => {
  function makeJournal(): Journal {
    return new Journal(openJournal(":memory:"));
  }

  test("recall by entity returns only matching memories", () => {
    const journal = makeJournal();
    seed(journal, baseRow({ id: "m1", entity: "alice" }));
    seed(journal, baseRow({ id: "m2", entity: "bob" }));

    const results = recall(journal, { entity: "alice" }, () => "2026-01-02T00:00:00.000Z");
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("m1");
  });

  test("recall by tag returns only tagged memories and attaches tags", () => {
    const journal = makeJournal();
    seed(journal, baseRow({ id: "m1" }), ["project-x", "important"]);
    seed(journal, baseRow({ id: "m2" }), ["other"]);

    const results = recall(journal, { tag: "project-x" }, () => "2026-01-02T00:00:00.000Z");
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("m1");
    expect(results[0]!.tags.sort()).toEqual(["important", "project-x"]);
  });

  test("recall by status returns only matching status", () => {
    const journal = makeJournal();
    seed(journal, baseRow({ id: "m1", status: "canonical" }));
    seed(journal, baseRow({ id: "m2", status: "working" }));

    const results = recall(journal, { status: "canonical" }, () => "2026-01-02T00:00:00.000Z");
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("m1");
  });

  test("recall by since excludes memories created before the cutoff", () => {
    const journal = makeJournal();
    seed(journal, baseRow({ id: "old", created: "2025-01-01T00:00:00.000Z" }));
    seed(journal, baseRow({ id: "new", created: "2026-06-01T00:00:00.000Z" }));

    const results = recall(
      journal,
      { since: "2026-01-01T00:00:00.000Z" },
      () => "2026-06-02T00:00:00.000Z",
    );
    expect(results.map((r) => r.id)).toEqual(["new"]);
  });

  test("recall respects limit", () => {
    const journal = makeJournal();
    seed(journal, baseRow({ id: "m1", created: "2026-01-01T00:00:00.000Z" }));
    seed(journal, baseRow({ id: "m2", created: "2026-01-02T00:00:00.000Z" }));
    seed(journal, baseRow({ id: "m3", created: "2026-01-03T00:00:00.000Z" }));

    const results = recall(journal, { limit: 2 }, () => "2026-01-04T00:00:00.000Z");
    expect(results).toHaveLength(2);
  });

  test("default recall excludes forgotten and reverted memories", () => {
    const journal = makeJournal();
    seed(journal, baseRow({ id: "working", status: "working" }));
    seed(journal, baseRow({ id: "forgotten", status: "forgotten" }));
    seed(journal, baseRow({ id: "reverted", status: "reverted" }));

    const results = recall(journal, {}, () => "2026-01-02T00:00:00.000Z");
    expect(results.map((r) => r.id).sort()).toEqual(["working"]);
  });

  test("default recall excludes retired memories (v0.3b)", () => {
    const journal = makeJournal();
    seed(journal, baseRow({ id: "working", status: "working" }));
    seed(journal, baseRow({ id: "retired", status: "retired" }));

    const results = recall(journal, {}, () => "2026-01-02T00:00:00.000Z");
    expect(results.map((r) => r.id).sort()).toEqual(["working"]);
  });

  test("explicit status filter for retired is honored (not force-excluded)", () => {
    const journal = makeJournal();
    seed(journal, baseRow({ id: "retired", status: "retired" }));
    seed(journal, baseRow({ id: "working", status: "working" }));

    const results = recall(journal, { status: "retired" }, () => "2026-01-02T00:00:00.000Z");
    expect(results.map((r) => r.id)).toEqual(["retired"]);
  });

  test("explicit status filter for forgotten/reverted is honored (not force-excluded)", () => {
    const journal = makeJournal();
    seed(journal, baseRow({ id: "forgotten", status: "forgotten" }));
    seed(journal, baseRow({ id: "working", status: "working" }));

    const results = recall(journal, { status: "forgotten" }, () => "2026-01-02T00:00:00.000Z");
    expect(results.map((r) => r.id)).toEqual(["forgotten"]);
  });

  test("provenance fields are present on results", () => {
    const journal = makeJournal();
    seed(
      journal,
      baseRow({
        id: "m1",
        entity: "alice",
        confidence: "high",
        source: "session-1",
        supersedes: "m0",
        expires: "2026-12-31T00:00:00.000Z",
      }),
    );

    const [result] = recall(journal, { entity: "alice" }, () => "2026-01-02T00:00:00.000Z");
    expect(result).toMatchObject({
      id: "m1",
      path: "Agent/Memory/m1.md",
      entity: "alice",
      status: "working",
      confidence: "high",
      created: "2026-01-01T00:00:00.000Z",
      source: "session-1",
      supersedes: "m0",
      expires: "2026-12-31T00:00:00.000Z",
    });
    expect(result!.tags).toEqual([]);
  });

  test("recall touches last_referenced on every returned memory", () => {
    const journal = makeJournal();
    seed(journal, baseRow({ id: "m1" }));
    expect(journal.getMemory("m1")!.last_referenced).toBeNull();

    recall(journal, { entity: undefined }, () => "2026-03-15T12:00:00.000Z");

    expect(journal.getMemory("m1")!.last_referenced).toBe("2026-03-15T12:00:00.000Z");
  });
});
