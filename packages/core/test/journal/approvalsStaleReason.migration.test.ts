import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openJournal } from "../../src/journal/db.js";

describe("approvals.stale_reason schema migration", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test("a fresh journal already carries stale_reason (from CREATE TABLE, not just the ALTER upgrade path)", () => {
    const freshDb = openJournal(":memory:");
    const columns = (freshDb.prepare(`pragma table_info(approvals)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(columns).toContain("stale_reason");
    freshDb.close();
  });

  test("a genuine legacy journal (pre-stale_reason) is upgraded in place by the migration; idempotent across two opens of the same file", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-approvals-stalereason-legacy-"));
    const dbPath = join(dir, "journal.db");

    // Simulate a pre-v0.3b2 journal: the original approvals shape, no
    // stale_reason column.
    const old = new Database(dbPath);
    old.exec(
      `CREATE TABLE approvals (
         id TEXT PRIMARY KEY,
         held_operation TEXT NOT NULL,
         zone TEXT NOT NULL,
         reason TEXT,
         session TEXT NOT NULL,
         state TEXT NOT NULL,
         created_at TEXT NOT NULL,
         resolved_at TEXT
       )`,
    );
    old.prepare(
      `INSERT INTO approvals (id, held_operation, zone, reason, session, state, created_at, resolved_at)
       VALUES ('apr_legacy', '{"op":"retire","id":"mem_1"}', 'canonical-retire', 'legacy row', 's1', 'pending', '2026-07-01T00:00:00.000Z', NULL)`,
    ).run();
    const oldColumns = (old.prepare(`pragma table_info(approvals)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    // Sanity: the migrated column is ABSENT before the upgrade.
    expect(oldColumns).not.toContain("stale_reason");
    old.close();

    // Opening through openJournal must run the ALTER migration, guarded and
    // idempotent (mirrors migrateTransactionsTable/migrateConflictsTable's
    // pragma table_info style).
    const upgraded = openJournal(dbPath);
    const columns = (upgraded.prepare(`pragma table_info(approvals)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(columns).toContain("stale_reason");

    // The pre-existing legacy row survives the upgrade, with stale_reason
    // defaulting to NULL (no ALTER-added DEFAULT needed for a nullable col).
    const row = upgraded.prepare(`SELECT * FROM approvals WHERE id = 'apr_legacy'`).get() as {
      stale_reason: string | null;
      state: string;
    };
    expect(row.stale_reason).toBeNull();
    expect(row.state).toBe("pending");
    upgraded.close();

    // Re-opening the SAME file must not throw (ALTER migration is guarded).
    expect(() => {
      const reopened = openJournal(dbPath);
      reopened.close();
    }).not.toThrow();
  });
});
