import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJournal } from "../../src/journal/db.js";

describe("ix_transactions_approval partial index", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test("ix_transactions_approval is created as a (non-unique) partial index, and re-opening the same file is idempotent", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-approvalindex-"));
    const dbPath = join(dir, "journal.db");

    const db1 = openJournal(dbPath);
    const indexList1 = db1
      .prepare("pragma index_list(transactions)")
      .all() as Array<{ name: string; unique: number; partial: number }>;
    const ix1 = indexList1.find((i) => i.name === "ix_transactions_approval");
    expect(ix1).toBeDefined();
    expect(ix1!.unique).toBe(0);
    expect(ix1!.partial).toBe(1);
    db1.close();

    // Re-opening the same on-disk file must not throw (CREATE ... IF NOT
    // EXISTS is idempotent) and the index must still be exactly there once.
    const db2 = openJournal(dbPath);
    const indexList2 = db2
      .prepare("pragma index_list(transactions)")
      .all() as Array<{ name: string; unique: number; partial: number }>;
    expect(indexList2.filter((i) => i.name === "ix_transactions_approval")).toHaveLength(1);
    db2.close();
  });

  test("in-memory journal also gets the index (fresh-schema path, not just upgrade path)", () => {
    const db = openJournal(":memory:");
    const indexList = db
      .prepare("pragma index_list(transactions)")
      .all() as Array<{ name: string }>;
    expect(indexList.find((i) => i.name === "ix_transactions_approval")).toBeDefined();
    db.close();
  });
});
