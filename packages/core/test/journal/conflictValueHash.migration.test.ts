import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import Database from "better-sqlite3";
import { openJournal } from "../../src/journal/db.js";
import { Journal, type MemoryRow } from "../../src/journal/journal.js";
import { checkContradictions } from "../../src/contradiction/check.js";
import { conflictValueHash } from "../../src/contradiction/valueHash.js";
import type { PermissionsManifest } from "../../src/schemas/manifest.js";
// Note: this file previously imported `hashBytes` directly to assert the
// backfill hash; it now asserts against `conflictValueHash` (the single
// hashing helper shared by the migration and the live check.ts path).

const MANIFEST: PermissionsManifest = {
  version: 1,
  mode: "assisted",
  zones: {
    agent: ["Agent/**"],
    scratch: ["Agent/Scratch/**"],
    excluded: ["Private/**"],
    trusted: ["**"],
  },
  overrides: [],
};

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
    // deterministically backfilled from the stored `detail` string via the
    // SAME `conflictValueHash` helper the live check.ts path uses (single
    // source of truth), so the migrated hash equals the live hash by
    // construction.
    expect(row.value_hash).not.toBe("");
    expect(row.value_hash).toBe(conflictValueHash(detail));

    const indexNames = (
      upgraded.prepare(`pragma index_list(conflicts)`).all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexNames).toContain("ux_conflicts_pair_kind_fact_value");
    expect(indexNames).not.toContain("ux_conflicts_pair_kind_fact");

    upgraded.close();
  });

  // F1 regression: the migration backfill and the live check.ts hash must
  // use the SAME preimage (the stored `detail` string). If they diverge (as
  // an earlier build did — backfill hashed `detail`, live hashed the sorted
  // value pair), the FIRST re-detection of a migrated legacy DISMISSED
  // conflict computes a live hash that misses the backfilled row's hash on
  // the 5-column ON CONFLICT, inserts a NEW OPEN row, and resurrects the
  // dismissal. This drives the real end-to-end path: legacy dismissed row ->
  // migrate -> checkContradictions re-produces the SAME contradiction ->
  // must dedup against the migrated row (no new/duplicate open row).
  test("F1 regression: a MIGRATED legacy dismissed conflict is not resurrected by re-detecting the SAME contradiction (backfill hash == live hash)", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-conflicts-vh-resurrect-"));
    const dbPath = join(dir, "journal.db");

    // The detail string exactly as checkContradictions builds it for these
    // two notes (id-sorted: mem_a=lo with 2026-08-15, mem_b=hi with
    // 2026-09-01) — this is what a pre-value_hash build would have stored.
    const detail = 'deadline: "2026-08-15" vs "2026-09-01"';

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
    old
      .prepare(
        `INSERT INTO conflicts
           (id, memory_a, memory_b, kind, created_at, state, entity, detail, fact_key, pair_lo, pair_hi, resolved_at)
         VALUES
           ('cf_legacy', 'mem_a', 'mem_b', 'value-conflict', '2026-07-01T00:00:00.000Z', 'dismissed', 'nova', @detail, 'deadline', 'mem_a', 'mem_b', null)`,
      )
      .run({ detail });
    old.close();

    // Upgrade in place (adds value_hash, backfills, swaps the index).
    const journal = new Journal(openJournal(dbPath));

    // Two live same-entity notes that re-produce that exact contradiction.
    writeNote(dir, "mem_a.md", "canonical", { deadline: "2026-08-15" });
    journal.insertMemory(memRow({ id: "mem_a", path: "mem_a.md", entity: "nova", status: "canonical" }));
    writeNote(dir, "mem_b.md", "canonical", { deadline: "2026-09-01" });
    journal.insertMemory(memRow({ id: "mem_b", path: "mem_b.md", entity: "nova", status: "canonical" }));

    const { now, genId } = makeClock();
    checkContradictions({ journal, vaultRoot: dir, manifest: MANIFEST, now, genId }, "mem_b");

    // The dismissal must HOLD: no new open row, and the only conflict row is
    // still the migrated dismissed one.
    expect(journal.listConflicts("open")).toHaveLength(0);
    const all = journal.listConflicts();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe("cf_legacy");
    expect(all[0]!.state).toBe("dismissed");
  });
});
