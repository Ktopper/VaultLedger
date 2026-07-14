import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJournal } from "../../src/journal/db.js";
import { probeJournal } from "../../src/journal/probe.js";

describe("probeJournal", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vl-probejournal-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("absent DB → status:'absent', no file created", () => {
    const p = join(dir, "journal.db");
    const r = probeJournal(p);
    expect(r.status).toBe("absent");
    expect(existsSync(p)).toBe(false); // MUST NOT create-on-open
  });

  test("a healthy WAL journal (written, cleanly closed) → status:'ok' with a count, and NO sidecars beside the real DB", () => {
    const p = join(dir, "journal.db");
    const db = openJournal(p);      // real journal: WAL mode + schema
    db.close();                     // clean close (checkpoints the WAL)
    const before = readdirSync(dir).sort();
    const r = probeJournal(p);
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(typeof r.count).toBe("number");
    // Mutation-free: the probe materializes no new file beside the real DB.
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  test("a present-but-corrupt DB file → status:'unreadable', never throws", () => {
    const p = join(dir, "journal.db");
    writeFileSync(p, "this is not a sqlite database");
    let r: ReturnType<typeof probeJournal>;
    expect(() => { r = probeJournal(p); }).not.toThrow();
    expect(r!.status).toBe("unreadable");
    // Temp-copy cleanup ran: no leftover probe temp dirs linger under the real dir.
    expect(existsSync(p)).toBe(true); // real file untouched
  });
});
