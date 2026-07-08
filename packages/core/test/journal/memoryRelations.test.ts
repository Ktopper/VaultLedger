import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openJournal } from "../../src/journal/db.js";
import { Journal, type MemoryRelationRow } from "../../src/journal/journal.js";

function relRow(overrides: Partial<MemoryRelationRow> = {}): MemoryRelationRow {
  return {
    memory_id: "mem_distilled",
    source_id: "mem_source_1",
    kind: "distilled",
    ...overrides,
  };
}

describe("memory_relations table (v0.3b distillation edges)", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test("a fresh journal carries the memory_relations table and its source index", () => {
    const db = openJournal(":memory:");

    const columns = (db.prepare(`pragma table_info(memory_relations)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(columns.sort()).toEqual(["kind", "memory_id", "source_id"]);

    const indexNames = (
      db.prepare(`pragma index_list(memory_relations)`).all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexNames).toContain("ix_memory_relations_source");

    db.close();
  });

  test("insertRelation + getRelationsForMemory round-trips two edges for one memory", () => {
    const journal = new Journal(openJournal(":memory:"));
    journal.insertRelation(relRow({ memory_id: "mem_d", source_id: "mem_a", kind: "distilled" }));
    journal.insertRelation(relRow({ memory_id: "mem_d", source_id: "mem_b", kind: "distilled" }));

    const rows = journal.getRelationsForMemory("mem_d");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.source_id).sort()).toEqual(["mem_a", "mem_b"]);
    expect(rows.every((r) => r.kind === "distilled")).toBe(true);
  });

  test("getDistillationsCitingSource finds a citing distillation via the source index", () => {
    const journal = new Journal(openJournal(":memory:"));
    journal.insertRelation(relRow({ memory_id: "mem_d1", source_id: "mem_src", kind: "distilled" }));
    journal.insertRelation(relRow({ memory_id: "mem_d2", source_id: "mem_other", kind: "distilled" }));

    const citing = journal.getDistillationsCitingSource("mem_src");
    expect(citing).toHaveLength(1);
    expect(citing[0]!.memory_id).toBe("mem_d1");
  });

  test("insertRelation is idempotent: re-inserting the same edge leaves exactly one row", () => {
    const journal = new Journal(openJournal(":memory:"));
    journal.insertRelation(relRow({ memory_id: "mem_d", source_id: "mem_a", kind: "distilled" }));
    journal.insertRelation(relRow({ memory_id: "mem_d", source_id: "mem_a", kind: "distilled" }));

    expect(journal.getRelationsForMemory("mem_d")).toHaveLength(1);
  });

  test("deleteRelationsForMemory removes all edges for a distillation", () => {
    const journal = new Journal(openJournal(":memory:"));
    journal.insertRelation(relRow({ memory_id: "mem_d", source_id: "mem_a", kind: "distilled" }));
    journal.insertRelation(relRow({ memory_id: "mem_d", source_id: "mem_b", kind: "distilled" }));

    journal.deleteRelationsForMemory("mem_d");
    expect(journal.getRelationsForMemory("mem_d")).toEqual([]);
  });

  test("re-opening an already-migrated journal is idempotent: no throw, no duplicate table/index", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-memory-relations-"));
    const dbPath = join(dir, "journal.db");

    const db1 = openJournal(dbPath);
    db1.close();

    expect(() => {
      const db2 = openJournal(dbPath);
      db2.close();
    }).not.toThrow();

    const db3 = openJournal(dbPath);
    const indexNames = (
      db3.prepare(`pragma index_list(memory_relations)`).all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexNames.filter((n) => n === "ix_memory_relations_source")).toHaveLength(1);
    db3.close();
  });

  test("a genuine legacy journal (pre-memory_relations, no such table) is upgraded in place by the migration", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-memory-relations-legacy-"));
    const dbPath = join(dir, "journal.db");

    // Simulate a pre-v0.3b journal: build the OLD schema (no memory_relations
    // table at all) directly via raw better-sqlite3, matching the shape
    // conflictValueHash.migration.test.ts uses for its legacy-DB fixture.
    const old = new Database(dbPath);
    old.exec(`
      CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        op TEXT NOT NULL,
        path TEXT NOT NULL,
        hash_before TEXT,
        hash_after TEXT,
        session TEXT NOT NULL,
        reason TEXT,
        memory_id TEXT,
        commit_sha TEXT,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        entity TEXT,
        status TEXT NOT NULL,
        confidence TEXT,
        created TEXT NOT NULL,
        source TEXT,
        supersedes TEXT,
        expires TEXT,
        last_referenced TEXT
      );
    `);
    const tablesBefore = (
      old.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    ).map((t) => t.name);
    expect(tablesBefore).not.toContain("memory_relations");
    old.close();

    const upgraded = new Journal(openJournal(dbPath));

    // The migration must have created the table AND it must be usable via
    // the normal Journal API (round-trip an edge through the upgraded DB).
    upgraded.insertRelation(relRow({ memory_id: "mem_up", source_id: "mem_src", kind: "distilled" }));
    expect(upgraded.getRelationsForMemory("mem_up")).toHaveLength(1);
  });
});
