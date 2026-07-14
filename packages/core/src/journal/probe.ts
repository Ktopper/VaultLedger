import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type JournalProbe =
  | { status: "absent" }
  | { status: "ok"; count: number }
  | { status: "unreadable"; error: string };

/**
 * Read-only journal inspection for `ledger doctor`. Leaves the REAL DB + its
 * directory byte-identical by opening a disposable temp COPY, never the real
 * file — a `{ readonly: true }` open of a WAL DB materializes `-wal`/`-shm`
 * sidecars beside the original (verified on macOS/better-sqlite3 11), and
 * better-sqlite3 doesn't support the `immutable=1` URI escape hatch. Copying
 * `journal.db` (+ any present sidecars) into a temp dir and opening THAT keeps
 * app-support untouched while still yielding an accurate committed+WAL count.
 *
 * `absent` is separated from `unreadable` via an `existsSync` pre-check so the
 * caller phrases the two differently. A torn copy taken while a live writer is
 * mid-transaction surfaces as `unreadable`; the doctor `journal` check
 * cross-references the lock probe to report that as "busy with an active
 * writer" rather than corruption.
 */
export function probeJournal(dbPath: string): JournalProbe {
  if (!existsSync(dbPath)) return { status: "absent" };
  const tmpDir = mkdtempSync(join(tmpdir(), "vl-journal-probe-"));
  const tmpDb = join(tmpDir, "journal.db");
  let db: Database.Database | undefined;
  try {
    copyFileSync(dbPath, tmpDb);
    for (const sfx of ["-wal", "-shm"]) {
      if (existsSync(dbPath + sfx)) copyFileSync(dbPath + sfx, tmpDb + sfx);
    }
    // Read-write open on the COPY is fine — it's disposable; this lets SQLite
    // run WAL recovery / build -shm against the copy, never the real file.
    db = new Database(tmpDb, { fileMustExist: true });
    const row = db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number };
    return { status: "ok", count: row.n };
  } catch (e) {
    return { status: "unreadable", error: e instanceof Error ? e.message : String(e) };
  } finally {
    db?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
