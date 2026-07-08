import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openJournal } from "../../src/journal/db.js";
import { Journal, type ConflictRow } from "../../src/journal/journal.js";

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

describe("conflicts schema migration", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test("adds the migrated columns and unique index; idempotent across two opens of the same file", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-conflicts-db-"));
    const dbPath = join(dir, "journal.db");

    const db1 = openJournal(dbPath);
    db1.close();
    // Re-opening the SAME file must not throw (ALTER/index migration is idempotent).
    expect(() => {
      const db2 = openJournal(dbPath);
      db2.close();
    }).not.toThrow();

    const db3 = openJournal(dbPath);
    const columns = (db3.prepare(`pragma table_info(conflicts)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    for (const expected of ["entity", "detail", "fact_key", "pair_lo", "pair_hi", "resolved_at"]) {
      expect(columns).toContain(expected);
    }

    const indexes = (db3.prepare(`pragma index_list(conflicts)`).all() as Array<{ name: string }>).map(
      (i) => i.name,
    );
    expect(indexes).toContain("ux_conflicts_pair_kind_fact_value");
    db3.close();
  });

  test("a fresh journal already carries the full v0.3a column set (from CREATE TABLE, not just the ALTER upgrade path)", () => {
    // Brand-new file: the columns must come from SCHEMA_SQL's CREATE TABLE
    // directly. (`conflicts` is empty in every real journal, so ALTER would
    // also add them — this asserts the fresh-install shape independently.)
    const freshDb = openJournal(":memory:");
    const columns = (freshDb.prepare(`pragma table_info(conflicts)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    for (const expected of [
      "id",
      "memory_a",
      "memory_b",
      "kind",
      "created_at",
      "state",
      "entity",
      "detail",
      "fact_key",
      "pair_lo",
      "pair_hi",
      "resolved_at",
    ]) {
      expect(columns).toContain(expected);
    }
    freshDb.close();
  });

  test("an OLD-shape journal (pre-v0.3a) is upgraded to the same full column set + unique index on open", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-conflicts-old-"));
    const dbPath = join(dir, "journal.db");

    // Simulate a pre-v0.3a journal: create just the original 6-column shape.
    const old = new Database(dbPath);
    old.exec(
      `CREATE TABLE conflicts (
         id TEXT PRIMARY KEY,
         memory_a TEXT,
         memory_b TEXT,
         kind TEXT,
         created_at TEXT,
         state TEXT
       )`,
    );
    const oldColumns = (old.prepare(`pragma table_info(conflicts)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    // Sanity: the migrated columns are ABSENT before the upgrade.
    expect(oldColumns).not.toContain("pair_lo");
    old.close();

    // Opening through openJournal must run the ALTER migration + index.
    const upgraded = openJournal(dbPath);
    const columns = (upgraded.prepare(`pragma table_info(conflicts)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    for (const expected of ["entity", "detail", "fact_key", "pair_lo", "pair_hi", "resolved_at"]) {
      expect(columns).toContain(expected);
    }
    const indexes = (upgraded.prepare(`pragma index_list(conflicts)`).all() as Array<{ name: string }>).map(
      (i) => i.name,
    );
    expect(indexes).toContain("ux_conflicts_pair_kind_fact_value");
    upgraded.close();
  });
});

function makeJournal(): { journal: Journal; db: Database.Database } {
  const db = openJournal(":memory:");
  return { journal: new Journal(db), db };
}

describe("Journal conflict helpers", () => {
  test("insertConflict twice with the same (pair_lo,pair_hi,kind,fact_key) key: second returns false, one row total", () => {
    const { journal } = makeJournal();
    const row = conflictRow();
    expect(journal.insertConflict(row)).toBe(true);
    expect(journal.insertConflict({ ...row, id: "cf_2" })).toBe(false);
    expect(journal.listConflicts().length).toBe(1);
  });

  test("dismissed-not-resurrected: a dismissed conflict is not reopened by a re-detected duplicate", () => {
    const { journal } = makeJournal();
    const row = conflictRow();
    expect(journal.insertConflict(row)).toBe(true);
    journal.setConflictState(row.id, "dismissed");

    expect(journal.insertConflict({ ...row, id: "cf_2" })).toBe(false);
    const stored = journal.getConflict(row.id);
    expect(stored).not.toBeNull();
    expect(stored!.state).toBe("dismissed");
    // No second row was created, and the dismissed one was not touched.
    expect(journal.listConflicts().length).toBe(1);
    expect(journal.getConflict("cf_2")).toBeNull();
  });

  test("listConflicts filters by state; newest first", () => {
    const { journal } = makeJournal();
    journal.insertConflict(conflictRow({ id: "cf_1", fact_key: "deadline", created_at: "2026-07-01T00:00:00.000Z" }));
    journal.insertConflict(conflictRow({ id: "cf_2", fact_key: "status", created_at: "2026-07-02T00:00:00.000Z" }));
    journal.setConflictState("cf_2", "resolved", "2026-07-03T00:00:00.000Z");

    const all = journal.listConflicts();
    expect(all.map((c) => c.id)).toEqual(["cf_2", "cf_1"]);

    const open = journal.listConflicts("open");
    expect(open.map((c) => c.id)).toEqual(["cf_1"]);

    const resolved = journal.listConflicts("resolved");
    expect(resolved.map((c) => c.id)).toEqual(["cf_2"]);
  });

  test("setConflictState updates state and (optionally) resolved_at", () => {
    const { journal } = makeJournal();
    const row = conflictRow();
    journal.insertConflict(row);

    journal.setConflictState(row.id, "resolved", "2026-07-05T00:00:00.000Z");
    const stored = journal.getConflict(row.id);
    expect(stored!.state).toBe("resolved");
    expect(stored!.resolved_at).toBe("2026-07-05T00:00:00.000Z");
  });
});
