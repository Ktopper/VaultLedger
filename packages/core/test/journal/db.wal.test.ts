import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJournal } from "../../src/journal/db.js";

describe("openJournal WAL mode", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test("a file-backed journal opens in WAL mode with a 5s busy_timeout", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-journal-wal-"));
    const dbPath = join(dir, "journal.db");
    const db = openJournal(dbPath);
    try {
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    } finally {
      db.close();
    }
  });

  test("an in-memory journal still opens (no WAL) and has the busy_timeout set", () => {
    const db = openJournal(":memory:");
    try {
      expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    } finally {
      db.close();
    }
  });
});
