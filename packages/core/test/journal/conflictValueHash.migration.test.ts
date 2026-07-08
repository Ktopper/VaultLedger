import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openJournal } from "../../src/journal/db.js";
import { hashBytes } from "../../src/broker/hash.js";

describe("conflicts.value_hash migration (dismiss-once dedup-key fix)", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test("a fresh journal carries value_hash NOT NULL and the 5-column unique index, not the old 4-column one", () => {
    const db = openJournal(":memory:");

    const columns = db.prepare(`pragma table_info(conflicts)`).all() as Array<{
      name: string;
      notnull: number;
    }>;
    const valueHashCol = columns.find((c) => c.name === "value_hash");
    expect(valueHashCol).toBeDefined();
    expect(valueHashCol!.notnull).toBe(1);

    const indexNames = (db.prepare(`pragma index_list(conflicts)`).all() as Array<{ name: string }>).map(
      (i) => i.name,
    );
    expect(indexNames).toContain("ux_conflicts_pair_kind_fact_value");
    expect(indexNames).not.toContain("ux_conflicts_pair_kind_fact");

    db.close();
  });

  test("re-opening an already-migrated journal is idempotent: no throw, no duplicate column/index", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-conflicts-vh-"));
    const dbPath = join(dir, "journal.db");

    const db1 = openJournal(dbPath);
    db1.close();

    expect(() => {
      const db2 = openJournal(dbPath);
      db2.close();
    }).not.toThrow();

    const db3 = openJournal(dbPath);
    const columnNames = (db3.prepare(`pragma table_info(conflicts)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(columnNames.filter((n) => n === "value_hash")).toHaveLength(1);

    const indexNames = (db3.prepare(`pragma index_list(conflicts)`).all() as Array<{ name: string }>).map(
      (i) => i.name,
    );
    expect(indexNames.filter((n) => n === "ux_conflicts_pair_kind_fact_value")).toHaveLength(1);
    db3.close();
  });

  test("a genuine legacy journal (pre-value_hash, with a real row) is upgraded: column added NOT NULL, existing row backfilled from its detail, old index dropped, new 5-col index created", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-conflicts-vh-old-"));
    const dbPath = join(dir, "journal.db");

    // Simulate a journal created by the pre-value_hash code: the full
    // pre-fix `conflicts` shape (matching db.ts's CONFLICTS_MIGRATED_COLUMNS
    // set) plus the OLD 4-column unique index, with one real row already in
    // it — the exact shape openJournal must upgrade in place.
    const old = new Database(dbPath);
    old.exec(`
      CREATE TABLE conflicts (
        id TEXT PRIMARY KEY,
        memory_a TEXT,
        memory_b TEXT,
        kind TEXT,
        created_at TEXT,
        state TEXT,
        entity TEXT,
        detail TEXT,
        fact_key TEXT,
        pair_lo TEXT,
        pair_hi TEXT,
        resolved_at TEXT
      )
    `);
    old.exec(
      `CREATE UNIQUE INDEX ux_conflicts_pair_kind_fact ON conflicts(pair_lo, pair_hi, kind, fact_key)`,
    );
    const detail = 'deadline: "2026-08-15" vs "2026-09-01"';
    old
      .prepare(
        `INSERT INTO conflicts
           (id, memory_a, memory_b, kind, created_at, state, entity, detail, fact_key, pair_lo, pair_hi, resolved_at)
         VALUES
           ('cf_legacy', 'mem_a', 'mem_b', 'value-conflict', '2026-07-01T00:00:00.000Z', 'dismissed', 'nova', @detail, 'deadline', 'mem_a', 'mem_b', null)`,
      )
      .run({ detail });
    const oldColumns = (old.prepare(`pragma table_info(conflicts)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(oldColumns).not.toContain("value_hash");
    old.close();

    const upgraded = openJournal(dbPath);

    const columns = upgraded.prepare(`pragma table_info(conflicts)`).all() as Array<{
      name: string;
      notnull: number;
    }>;
    const valueHashCol = columns.find((c) => c.name === "value_hash");
    expect(valueHashCol).toBeDefined();
    expect(valueHashCol!.notnull).toBe(1);

    const row = upgraded
      .prepare(`SELECT value_hash FROM conflicts WHERE id = 'cf_legacy'`)
      .get() as { value_hash: string };
    // No row is left un-dedupable behind the placeholder '' — it was
    // deterministically backfilled from the stored `detail` string.
    expect(row.value_hash).not.toBe("");
    expect(row.value_hash).toBe(hashBytes(Buffer.from(detail, "utf8")));

    const indexNames = (
      upgraded.prepare(`pragma index_list(conflicts)`).all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexNames).toContain("ux_conflicts_pair_kind_fact_value");
    expect(indexNames).not.toContain("ux_conflicts_pair_kind_fact");

    upgraded.close();
  });
});
