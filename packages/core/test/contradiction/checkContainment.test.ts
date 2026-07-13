// VL-SEC-S3-01/S3-03 + VL-SEC-S7-02: checkContradictions' file reads
// (contradiction/check.ts:40,45 pre-fix) used a raw
// `readFileSync(join(vaultRoot, mem.path/peer.path))`, WITHOUT routing
// through `assertContainedAndReadable` -- the shared containment + zone gate
// every OTHER in-process vault reader honors. Two blast radii, both proven
// here:
//   - S3-01/S3-03: a hostile `path` (e.g. "../outside/secret.md") that
//     somehow reaches the journal escapes vaultRoot entirely; its content
//     could be read and embedded into `conflicts.detail`.
//   - S7-02: an excluded-zone path (a legitimate manifest shape, e.g. a
//     nested Private/** or an override) is read and its ACTUAL FACT VALUE
//     leaks verbatim into `conflicts.detail`, a column surfaced to
//     `ledger conflicts`/`GET /conflicts`.
// This file seeds journal rows directly (bypassing every real producer, per
// security/poc/s3-read.mjs's documented rationale) to exercise check.ts's
// read behavior in isolation from whether a hostile/excluded path could
// reach the journal today.
import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, type MemoryRow } from "../../src/journal/journal.js";
import { openJournal } from "../../src/journal/db.js";
import { checkContradictions } from "../../src/contradiction/check.js";
import type { PermissionsManifest } from "../../src/schemas/manifest.js";

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

function memRow(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: "mem_1",
    path: "mem_1.md",
    entity: "acme",
    status: "working",
    confidence: "medium",
    created: "2026-01-01T00:00:00.000Z",
    source: "poc",
    supersedes: null,
    expires: null,
    last_referenced: null,
    ...overrides,
  };
}

describe("checkContradictions containment gate (VL-SEC-S3-01/S3-03/S7-02)", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test("a hostile traversal path on a peer memory is refused: no read escapes vaultRoot, and the outside content never reaches conflicts.detail", () => {
    const root = mkdtempSync(join(tmpdir(), "vl-checkcontain-"));
    dir = root;
    const vaultRoot = join(root, "vault");
    const outsideDir = join(root, "outside"); // sibling of vaultRoot, NOT under it
    mkdirSync(join(vaultRoot, "Agent", "Memory"), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });

    // A file the vault should never be able to read (stands in for
    // /etc/passwd or a sibling user's private note), crafted so its content
    // would extract as fact key "secret" if ever read.
    writeFileSync(join(outsideDir, "private-secret.md"), "secret: sk-live-DO-NOT-LEAK-abc123\n", "utf8");

    // The legitimate in-vault memory, declaring a CONFLICTING value for the
    // same fact key so the heuristic detector would fire if the peer's
    // content were ever actually read.
    const targetRelPath = "Agent/Memory/mem_target.md";
    writeFileSync(join(vaultRoot, targetRelPath), "---\nentity: acme\n---\nsecret: known-safe-value\n", "utf8");

    const journal = new Journal(openJournal(":memory:"));
    const { now, genId } = makeClock();

    journal.insertMemory(memRow({ id: "mem_target", path: targetRelPath, entity: "acme", status: "working" }));
    // The HOSTILE row: same entity (pairs with mem_target), live status, but
    // `path` traverses outside vaultRoot entirely.
    const hostileRelPath = "../outside/private-secret.md";
    journal.insertMemory(memRow({ id: "mem_evil", path: hostileRelPath, entity: "acme", status: "working" }));

    expect(() =>
      checkContradictions({ journal, vaultRoot, manifest: MANIFEST, now, genId }, "mem_target"),
    ).not.toThrow();

    const conflicts = journal.listConflicts();
    for (const c of conflicts) {
      expect((c.detail ?? "").toLowerCase()).not.toContain("sk-live-do-not-leak-abc123");
    }
    // No conflict should even reference the hostile row -- the read was
    // refused before any comparison against it could happen.
    expect(conflicts.some((c) => c.memory_a === "mem_evil" || c.memory_b === "mem_evil")).toBe(false);
  });

  test("an excluded-zone peer's content is refused and never leaks into conflicts.detail", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "vl-checkcontain-excl-"));
    dir = vaultRoot;
    mkdirSync(join(vaultRoot, "Agent", "Memory"), { recursive: true });
    mkdirSync(join(vaultRoot, "Private"), { recursive: true });

    // The excluded-zone note genuinely exists on disk and genuinely
    // contradicts the target -- the ONLY thing that should prevent the leak
    // is the zone gate, not a missing file.
    const excludedRelPath = "Private/secret.md";
    writeFileSync(join(vaultRoot, excludedRelPath), "---\nentity: acme\n---\ndeadline: 1999-01-01\n", "utf8");

    const targetRelPath = "Agent/Memory/mem_target2.md";
    writeFileSync(join(vaultRoot, targetRelPath), "---\nentity: acme\n---\ndeadline: 2026-08-15\n", "utf8");

    const journal = new Journal(openJournal(":memory:"));
    const { now, genId } = makeClock();

    journal.insertMemory(memRow({ id: "mem_target2", path: targetRelPath, entity: "acme", status: "working" }));
    journal.insertMemory(
      memRow({ id: "mem_excluded_peer", path: excludedRelPath, entity: "acme", status: "working" }),
    );

    expect(() =>
      checkContradictions({ journal, vaultRoot, manifest: MANIFEST, now, genId }, "mem_target2"),
    ).not.toThrow();

    const conflicts = journal.listConflicts();
    for (const c of conflicts) {
      expect(c.detail ?? "").not.toContain("1999-01-01");
    }
    expect(
      conflicts.some((c) => c.memory_a === "mem_excluded_peer" || c.memory_b === "mem_excluded_peer"),
    ).toBe(false);
  });

  test("a hostile traversal path on the CHECKED memory itself aborts the whole check (non-blocking: never throws)", () => {
    const root = mkdtempSync(join(tmpdir(), "vl-checkcontain-self-"));
    dir = root;
    const vaultRoot = join(root, "vault");
    const outsideDir = join(root, "outside");
    mkdirSync(vaultRoot, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "self-secret.md"), "secret: sk-self-leak\n", "utf8");

    const journal = new Journal(openJournal(":memory:"));
    const { now, genId } = makeClock();

    journal.insertMemory(
      memRow({ id: "mem_self_evil", path: "../outside/self-secret.md", entity: "acme", status: "working" }),
    );
    journal.insertMemory(memRow({ id: "mem_peer", path: "peer.md", entity: "acme", status: "working" }));
    writeFileSync(join(vaultRoot, "peer.md"), "---\nentity: acme\n---\nsecret: value\n", "utf8");

    // checkContradictions' contract (design §4.1): a detection failure must
    // never surface to the caller. The hostile self-path is refused by
    // assertContainedAndReadable and swallowed by the outer catch.
    expect(() =>
      checkContradictions({ journal, vaultRoot, manifest: MANIFEST, now, genId }, "mem_self_evil"),
    ).not.toThrow();
    expect(journal.listConflicts()).toHaveLength(0);
  });

  test("no-over-blocking control: two ordinary in-vault, non-excluded notes still detect a real contradiction (the fix must not break the happy path)", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "vl-checkcontain-happy-"));
    dir = vaultRoot;
    mkdirSync(join(vaultRoot, "Agent", "Memory"), { recursive: true });

    writeFileSync(join(vaultRoot, "Agent/Memory/mem_a.md"), "---\nentity: acme\n---\ndeadline: 2026-08-15\n", "utf8");
    writeFileSync(join(vaultRoot, "Agent/Memory/mem_b.md"), "---\nentity: acme\n---\ndeadline: 2026-09-01\n", "utf8");

    const journal = new Journal(openJournal(":memory:"));
    const { now, genId } = makeClock();
    journal.insertMemory(memRow({ id: "mem_a", path: "Agent/Memory/mem_a.md", entity: "acme", status: "canonical" }));
    journal.insertMemory(memRow({ id: "mem_b", path: "Agent/Memory/mem_b.md", entity: "acme", status: "working" }));

    checkContradictions({ journal, vaultRoot, manifest: MANIFEST, now, genId }, "mem_b");

    const open = journal.listConflicts("open");
    expect(open).toHaveLength(1);
    expect(open[0]!.fact_key).toBe("deadline");
    expect([open[0]!.memory_a, open[0]!.memory_b].sort()).toEqual(["mem_a", "mem_b"]);
  });
});
