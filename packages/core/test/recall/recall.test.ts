import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { openJournal } from "../../src/journal/db.js";
import { Journal, type MemoryRow } from "../../src/journal/journal.js";
import { recall, byteSafeTruncate, authorityRank } from "../../src/recall/recall.js";
import type { PermissionsManifest } from "../../src/schemas/manifest.js";

function writeNote(vaultRoot: string, relPath: string, body: string, fm = "ledger:\n  status: working\n"): void {
  const abs = join(vaultRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `---\n${fm}---\n\n${body}\n`, "utf8");
}

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

function seed(journal: Journal, row: MemoryRow, tags: string[] = []): void {
  journal.insertMemory(row);
  if (tags.length > 0) journal.addTags(row.id, tags);
}

function baseRow(overrides: Partial<MemoryRow> & { id: string }): MemoryRow {
  return {
    path: `Agent/Memory/${overrides.id}.md`,
    entity: null,
    status: "working",
    confidence: "medium",
    created: "2026-01-01T00:00:00.000Z",
    source: "s1",
    supersedes: null,
    expires: null,
    last_referenced: null,
    ...overrides,
  };
}

describe("recall", () => {
  function makeJournal(): Journal {
    return new Journal(openJournal(":memory:"));
  }

  test("recall by entity returns only matching memories", () => {
    const journal = makeJournal();
    seed(journal, baseRow({ id: "m1", entity: "alice" }));
    seed(journal, baseRow({ id: "m2", entity: "bob" }));

    const results = recall(journal, { entity: "alice" }, () => "2026-01-02T00:00:00.000Z", MANIFEST);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("m1");
  });

  test("recall by tag returns only tagged memories and attaches tags", () => {
    const journal = makeJournal();
    seed(journal, baseRow({ id: "m1" }), ["project-x", "important"]);
    seed(journal, baseRow({ id: "m2" }), ["other"]);

    const results = recall(journal, { tag: "project-x" }, () => "2026-01-02T00:00:00.000Z", MANIFEST);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("m1");
    expect(results[0]!.tags.sort()).toEqual(["important", "project-x"]);
  });

  test("recall by status returns only matching status", () => {
    const journal = makeJournal();
    seed(journal, baseRow({ id: "m1", status: "canonical" }));
    seed(journal, baseRow({ id: "m2", status: "working" }));

    const results = recall(journal, { status: "canonical" }, () => "2026-01-02T00:00:00.000Z", MANIFEST);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("m1");
  });

  test("recall by since excludes memories created before the cutoff", () => {
    const journal = makeJournal();
    seed(journal, baseRow({ id: "old", created: "2025-01-01T00:00:00.000Z" }));
    seed(journal, baseRow({ id: "new", created: "2026-06-01T00:00:00.000Z" }));

    const results = recall(
      journal,
      { since: "2026-01-01T00:00:00.000Z" },
      () => "2026-06-02T00:00:00.000Z",
      MANIFEST,
    );
    expect(results.map((r) => r.id)).toEqual(["new"]);
  });

  test("recall respects limit", () => {
    const journal = makeJournal();
    seed(journal, baseRow({ id: "m1", created: "2026-01-01T00:00:00.000Z" }));
    seed(journal, baseRow({ id: "m2", created: "2026-01-02T00:00:00.000Z" }));
    seed(journal, baseRow({ id: "m3", created: "2026-01-03T00:00:00.000Z" }));

    const results = recall(journal, { limit: 2 }, () => "2026-01-04T00:00:00.000Z", MANIFEST);
    expect(results).toHaveLength(2);
  });

  test("recall order is deterministic: equal created ties break by id ascending", () => {
    const journal = makeJournal();
    // Insert b BEFORE a so any reliance on insertion order would surface m_b first.
    seed(journal, baseRow({ id: "m_b", created: "2026-01-01T00:00:00.000Z" }));
    seed(journal, baseRow({ id: "m_a", created: "2026-01-01T00:00:00.000Z" }));

    const results = recall(journal, {}, () => "2026-01-02T00:00:00.000Z", MANIFEST);
    expect(results.map((r) => r.id)).toEqual(["m_a", "m_b"]);
  });

  test("default recall excludes forgotten and reverted memories", () => {
    const journal = makeJournal();
    seed(journal, baseRow({ id: "working", status: "working" }));
    seed(journal, baseRow({ id: "forgotten", status: "forgotten" }));
    seed(journal, baseRow({ id: "reverted", status: "reverted" }));

    const results = recall(journal, {}, () => "2026-01-02T00:00:00.000Z", MANIFEST);
    expect(results.map((r) => r.id).sort()).toEqual(["working"]);
  });

  test("default recall excludes retired memories (v0.3b)", () => {
    const journal = makeJournal();
    seed(journal, baseRow({ id: "working", status: "working" }));
    seed(journal, baseRow({ id: "retired", status: "retired" }));

    const results = recall(journal, {}, () => "2026-01-02T00:00:00.000Z", MANIFEST);
    expect(results.map((r) => r.id).sort()).toEqual(["working"]);
  });

  test("explicit status filter for retired is honored (not force-excluded)", () => {
    const journal = makeJournal();
    seed(journal, baseRow({ id: "retired", status: "retired" }));
    seed(journal, baseRow({ id: "working", status: "working" }));

    const results = recall(journal, { status: "retired" }, () => "2026-01-02T00:00:00.000Z", MANIFEST);
    expect(results.map((r) => r.id)).toEqual(["retired"]);
  });

  test("explicit status filter for forgotten/reverted is honored (not force-excluded)", () => {
    const journal = makeJournal();
    seed(journal, baseRow({ id: "forgotten", status: "forgotten" }));
    seed(journal, baseRow({ id: "working", status: "working" }));

    const results = recall(journal, { status: "forgotten" }, () => "2026-01-02T00:00:00.000Z", MANIFEST);
    expect(results.map((r) => r.id)).toEqual(["forgotten"]);
  });

  test("provenance fields are present on results", () => {
    const journal = makeJournal();
    seed(
      journal,
      baseRow({
        id: "m1",
        entity: "alice",
        confidence: "high",
        source: "session-1",
        supersedes: "m0",
        expires: "2026-12-31T00:00:00.000Z",
      }),
    );

    const [result] = recall(journal, { entity: "alice" }, () => "2026-01-02T00:00:00.000Z", MANIFEST);
    expect(result).toMatchObject({
      id: "m1",
      path: "Agent/Memory/m1.md",
      entity: "alice",
      status: "working",
      confidence: "high",
      created: "2026-01-01T00:00:00.000Z",
      source: "session-1",
      supersedes: "m0",
      expires: "2026-12-31T00:00:00.000Z",
    });
    expect(result!.tags).toEqual([]);
  });

  test("recall touches last_referenced on every returned memory", () => {
    const journal = makeJournal();
    seed(journal, baseRow({ id: "m1" }));
    expect(journal.getMemory("m1")!.last_referenced).toBeNull();

    recall(journal, { entity: undefined }, () => "2026-03-15T12:00:00.000Z", MANIFEST);

    expect(journal.getMemory("m1")!.last_referenced).toBe("2026-03-15T12:00:00.000Z");
  });

  // -------------------------------------------------------------------
  // VL-SEC-S7-05: defense-in-depth zone re-check. recall() must not trust
  // the journal is zone-clean by construction -- it re-resolves each row's
  // path against the manifest and filters out anything that now resolves to
  // `excluded`, independent of whatever gate the producer (reindex/store)
  // applied. This is what still catches a leak if a FUTURE producer
  // regresses, even after reindex.ts/check.ts are fixed.
  // -------------------------------------------------------------------

  test("VL-SEC-S7-05: a journal row whose path resolves to the excluded zone is filtered out of recall's results", () => {
    const journal = makeJournal();
    seed(journal, baseRow({ id: "m1", path: "Private/secret.md", entity: "alice" }));
    seed(journal, baseRow({ id: "m2", path: "Agent/Memory/m2.md", entity: "alice" }));

    const results = recall(journal, {}, () => "2026-01-02T00:00:00.000Z", MANIFEST);

    expect(results.map((r) => r.id)).toEqual(["m2"]);
  });

  test("VL-SEC-S7-05: an excluded-zone row is filtered even under an explicit status filter (not just the default view)", () => {
    const journal = makeJournal();
    seed(journal, baseRow({ id: "m1", path: "Private/secret.md", entity: "alice", status: "canonical" }));
    seed(journal, baseRow({ id: "m2", path: "Agent/Memory/m2.md", entity: "alice", status: "canonical" }));

    const results = recall(journal, { status: "canonical" }, () => "2026-01-02T00:00:00.000Z", MANIFEST);

    expect(results.map((r) => r.id)).toEqual(["m2"]);
  });

  test("VL-SEC-S7-05: filtering an excluded-zone row logs an integrity violation and does not touch its last_referenced", () => {
    const journal = makeJournal();
    seed(journal, baseRow({ id: "m1", path: "Private/secret.md", entity: "alice" }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      recall(journal, {}, () => "2026-01-02T00:00:00.000Z", MANIFEST);
    } finally {
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    }

    // Filtered rows are never "touched" -- recall() never returned them, so
    // it must not have updated last_referenced either.
    expect(journal.getMemory("m1")!.last_referenced).toBeNull();
  });

  // -------------------------------------------------------------------
  // Content reading (0.4.2): recall reads each memory's note body when a
  // vaultRoot is supplied. Zone-gated, frontmatter-stripped, byte-bounded,
  // authority-first budget. Spec docs/design/specs/2026-07-16-*.md §2.4/§2.5.
  // -------------------------------------------------------------------

  function mkVault(): string {
    return mkdtempSync(join(tmpdir(), "vl-recall-content-"));
  }

  test("content: body under cap -> full, frontmatter stripped", () => {
    const journal = makeJournal();
    const vaultRoot = mkVault();
    seed(journal, baseRow({ id: "m1", entity: "alice" }));
    writeNote(vaultRoot, "Agent/Memory/m1.md", "hello world");

    const [r] = recall(journal, { entity: "alice" }, () => "2026-01-02T00:00:00.000Z", MANIFEST, {
      vaultRoot,
      contentCap: 32,
      contentBudget: 1000,
    });
    expect(r!.contentState).toBe("full");
    expect(r!.content).toBe("hello world");
    expect(r!.content).not.toContain("---");
    expect(r!.content).not.toContain("ledger:");
  });

  test("content: load-bearing marker round-trips through content", () => {
    const journal = makeJournal();
    const vaultRoot = mkVault();
    seed(journal, baseRow({ id: "m1", entity: "alice" }));
    writeNote(vaultRoot, "Agent/Memory/m1.md", "The value is MARKER-abc123 for the record.");

    const [r] = recall(journal, { entity: "alice" }, () => "2026-01-02T00:00:00.000Z", MANIFEST, {
      vaultRoot,
      contentCap: 32,
      contentBudget: 1000,
    });
    expect(r!.content).toContain("MARKER-abc123");
  });

  test("content: body over cap with a multibyte char straddling the cap -> truncated, byte-safe, char not split", () => {
    const journal = makeJournal();
    const vaultRoot = mkVault();
    // 31 ASCII bytes, then "é" (2 bytes) occupying bytes 31-32, then more.
    const body = "a".repeat(31) + "é" + "z".repeat(10);
    seed(journal, baseRow({ id: "m1", entity: "alice" }));
    writeNote(vaultRoot, "Agent/Memory/m1.md", body);

    const [r] = recall(journal, { entity: "alice" }, () => "2026-01-02T00:00:00.000Z", MANIFEST, {
      vaultRoot,
      contentCap: 32,
      contentBudget: 1000,
    });
    expect(r!.contentState).toBe("truncated");
    expect(r!.content).toBe("a".repeat(31)); // "é" backed off, not split
    expect(r!.content).not.toContain("�"); // no replacement artifact
    expect(Buffer.byteLength(r!.content!, "utf8")).toBeLessThanOrEqual(32);
  });

  test("content: file never written -> missing, content null, row still returned", () => {
    const journal = makeJournal();
    const vaultRoot = mkVault();
    seed(journal, baseRow({ id: "m1", entity: "alice" }));
    // no writeNote — the file is absent

    const [r] = recall(journal, { entity: "alice" }, () => "2026-01-02T00:00:00.000Z", MANIFEST, {
      vaultRoot,
      contentCap: 32,
      contentBudget: 1000,
    });
    expect(r!.id).toBe("m1");
    expect(r!.contentState).toBe("missing");
    expect(r!.content).toBeNull();
  });

  test("content: malformed YAML frontmatter degrades to missing, recall still succeeds", () => {
    const journal = makeJournal();
    const vaultRoot = mkVault();
    seed(journal, baseRow({ id: "m1", entity: "alice" }));
    const abs = join(vaultRoot, "Agent/Memory/m1.md");
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "---\n: : :\n---\nbody\n", "utf8"); // invalid YAML -> matter() throws

    const results = recall(journal, { entity: "alice" }, () => "2026-01-02T00:00:00.000Z", MANIFEST, {
      vaultRoot,
      contentCap: 32,
      contentBudget: 1000,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.contentState).toBe("missing");
    expect(results[0]!.content).toBeNull();
  });

  test("content: authority-first budget — canonical keeps content, newer scratch is omitted", () => {
    const journal = makeJournal();
    const vaultRoot = mkVault();
    // canonical: 20-byte body; scratch: NEWER, 30-byte body. Budget 40 fits
    // only the canonical (20); scratch (20+30=50>40) is omitted even though it
    // is newer (and thus higher in the returned created-DESC array).
    seed(journal, baseRow({ id: "canon", status: "canonical", created: "2026-01-01T00:00:00.000Z" }));
    seed(journal, baseRow({ id: "scr", status: "scratch", created: "2026-02-01T00:00:00.000Z" }));
    writeNote(vaultRoot, "Agent/Memory/canon.md", "c".repeat(20));
    writeNote(vaultRoot, "Agent/Memory/scr.md", "s".repeat(30));

    const results = recall(journal, {}, () => "2026-03-01T00:00:00.000Z", MANIFEST, {
      vaultRoot,
      contentCap: 32,
      contentBudget: 40,
    });
    const byId = new Map(results.map((r) => [r.id, r]));
    // scratch is newer -> first in the returned created-DESC array
    expect(results[0]!.id).toBe("scr");
    expect(byId.get("canon")!.contentState).toBe("full");
    expect(byId.get("scr")!.contentState).toBe("omitted");
    expect(byId.get("scr")!.content).toBeNull();
  });

  test("content: monotonicity — first-overflow-stops, NOT best-fit (non-packing is intentional)", () => {
    const journal = makeJournal();
    const vaultRoot = mkVault();
    // Authority order: canonical(20) > working(30) > scratch(5). Budget 40:
    // canonical full (20); working overflows (20+30=50>40) -> omit-mode ON;
    // scratch omitted EVEN THOUGH its 5 bytes would have fit (20+5=25<=40).
    // Pins: if X has content, everything more authoritative than X does too.
    seed(journal, baseRow({ id: "canon", status: "canonical", created: "2026-01-03T00:00:00.000Z" }));
    seed(journal, baseRow({ id: "work", status: "working", created: "2026-01-02T00:00:00.000Z" }));
    seed(journal, baseRow({ id: "scr", status: "scratch", created: "2026-01-01T00:00:00.000Z" }));
    writeNote(vaultRoot, "Agent/Memory/canon.md", "c".repeat(20));
    writeNote(vaultRoot, "Agent/Memory/work.md", "w".repeat(30));
    writeNote(vaultRoot, "Agent/Memory/scr.md", "s".repeat(5));

    const results = recall(journal, {}, () => "2026-03-01T00:00:00.000Z", MANIFEST, {
      vaultRoot,
      contentCap: 32,
      contentBudget: 40,
    });
    const byId = new Map(results.map((r) => [r.id, r]));
    expect(byId.get("canon")!.contentState).toBe("full");
    expect(byId.get("work")!.contentState).toBe("omitted");
    expect(byId.get("scr")!.contentState).toBe("omitted"); // would have fit, still omitted
  });

  test("content: budget-beats-missing — a past-budget memory with a deleted file is omitted, not missing", () => {
    const journal = makeJournal();
    const vaultRoot = mkVault();
    // canonical(20) full; working(30) overflows -> omit-mode; scratch file
    // deleted but PAST budget -> never read -> omitted (NOT missing).
    seed(journal, baseRow({ id: "canon", status: "canonical", created: "2026-01-03T00:00:00.000Z" }));
    seed(journal, baseRow({ id: "work", status: "working", created: "2026-01-02T00:00:00.000Z" }));
    seed(journal, baseRow({ id: "scr", status: "scratch", created: "2026-01-01T00:00:00.000Z" }));
    writeNote(vaultRoot, "Agent/Memory/canon.md", "c".repeat(20));
    writeNote(vaultRoot, "Agent/Memory/work.md", "w".repeat(30));
    // scr.md deliberately never written

    const results = recall(journal, {}, () => "2026-03-01T00:00:00.000Z", MANIFEST, {
      vaultRoot,
      contentCap: 32,
      contentBudget: 40,
    });
    const byId = new Map(results.map((r) => [r.id, r]));
    expect(byId.get("work")!.contentState).toBe("omitted");
    expect(byId.get("scr")!.contentState).toBe("omitted"); // budget wins, file never read
  });

  test("content: metadata-only recall (no opts) has no content/contentState", () => {
    const journal = makeJournal();
    seed(journal, baseRow({ id: "m1", entity: "alice" }));

    const [r] = recall(journal, { entity: "alice" }, () => "2026-01-02T00:00:00.000Z", MANIFEST);
    expect(r).not.toHaveProperty("content");
    expect(r).not.toHaveProperty("contentState");
  });
});

describe("byteSafeTruncate", () => {
  test("under cap → unchanged, not truncated", () => {
    expect(byteSafeTruncate("hello", 100)).toEqual({ text: "hello", truncated: false });
  });
  test("over cap on an ASCII boundary → cut exactly, truncated", () => {
    expect(byteSafeTruncate("abcdef", 3)).toEqual({ text: "abc", truncated: true });
  });
  test("NEVER splits a multibyte char — cap mid-emoji backs off to the boundary", () => {
    const r = byteSafeTruncate("a😀", 3); // 😀 is 4 bytes
    expect(r.text).toBe("a");
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(3);
  });
  test("cap exactly on a char boundary keeps the whole char", () => {
    expect(byteSafeTruncate("é", 2)).toEqual({ text: "é", truncated: false }); // é is 2 bytes
  });
});

describe("authorityRank", () => {
  test("canonical < working < rest", () => {
    expect(authorityRank("canonical")).toBeLessThan(authorityRank("working"));
    expect(authorityRank("working")).toBeLessThan(authorityRank("scratch"));
    expect(authorityRank("retired")).toBe(authorityRank("scratch"));
    expect(authorityRank("unknown")).toBe(authorityRank("scratch"));
  });
});
