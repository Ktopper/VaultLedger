// VL-SEC-S7-01: reindex() must zone-gate the walk. Before the fix,
// reindex's walkMarkdownFiles/upsert loop treats Agent/Memory + Agent/Archive
// as fixed directory names and never calls resolveZone on anything it finds
// -- so a note that lives in (or is later moved into) an `excluded` zone,
// e.g. via a manifest override nesting a "Confidential" subfolder inside
// Agent/Memory, gets upserted into the journal anyway. Once indexed,
// recall() hands its path/entity/tags straight back to the agent with no
// zone awareness of its own (that's VL-SEC-S7-05's job, tested separately in
// recall.test.ts) -- this file proves the FIRST gate, at the producer.
import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerGit, formatMessage } from "../../src/broker/git.js";
import { Journal } from "../../src/journal/journal.js";
import { openJournal } from "../../src/journal/db.js";
import { recall } from "../../src/recall/recall.js";
import { reindex } from "../../src/memory/reindex.js";
import { resolveZone } from "../../src/zones.js";
import type { PermissionsManifest } from "../../src/schemas/manifest.js";

// Mirrors security/poc/s7-01-reindex-excluded-bypass.mjs's manifest shape: a
// human nests a folder of sensitive, manually-imported notes INSIDE the
// agent-managed memory tree and excludes just that subfolder via an
// override -- an ordinary, supported manifest shape (zones.ts: "overrides
// ALWAYS beat base zones").
const MANIFEST: PermissionsManifest = {
  version: 1,
  mode: "assisted",
  zones: {
    agent: ["Agent/**"],
    scratch: ["Agent/Scratch/**"],
    excluded: ["Private/**"],
    trusted: ["**"],
  },
  overrides: [{ glob: "Agent/Memory/Confidential/**", zone: "excluded" }],
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

describe("reindex zone-gating (VL-SEC-S7-01)", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  async function makeHarness(): Promise<{
    journal: Journal;
    git: LedgerGit;
    vaultRoot: string;
    now: () => string;
    genId: (prefix: string) => string;
  }> {
    const vaultRoot = mkdtempSync(join(tmpdir(), "vl-reindexzone-"));
    dir = vaultRoot;
    const git = new LedgerGit(vaultRoot);
    await git.init();
    const journal = new Journal(openJournal(":memory:"));
    const { now, genId } = makeClock();
    return { journal, git, vaultRoot, now, genId };
  }

  async function seedNote(
    git: LedgerGit,
    vaultRoot: string,
    relPath: string,
    id: string,
    body: string,
  ): Promise<void> {
    const noteBody = `---
entity: jane-doe
tags:
  - pii
ledger:
  id: ${id}
  status: working
  created: '2026-01-01T00:00:00.000Z'
  source: manual-import
  reason: imported from old case notes
  confidence: high
  supersedes: null
  expires: null
---
${body}
`;
    const abs = join(vaultRoot, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, noteBody, "utf8");
    await git.commitFile(
      relPath,
      formatMessage({ op: "create", basename: relPath.split("/").pop()!, memoryId: id, session: "human-import" }),
    );
  }

  test("sanity: the override manifest resolves the confidential subfolder to excluded", () => {
    expect(resolveZone("Agent/Memory/Confidential/secret.md", MANIFEST)).toBe("excluded");
  });

  test("a note nested under an excluded-zone override is NOT upserted into the journal, and is reported in excludedZone", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();

    const secretRelPath = "Agent/Memory/Confidential/secret.md";
    await seedNote(git, vaultRoot, secretRelPath, "mem_secret1", "Client Jane Doe's SSN is 555-11-2222.");

    // An ordinary, legitimately-agent-zone memory alongside it, for contrast.
    const normalRelPath = "Agent/Memory/mem_normal1.md";
    await seedNote(git, vaultRoot, normalRelPath, "mem_normal1", "User prefers dark mode.");

    const result = await reindex({ vaultRoot, git, journal, manifest: MANIFEST, now, genId });

    // The legitimate note is indexed; the excluded one is not.
    expect(journal.getMemory("mem_normal1")).not.toBeNull();
    expect(journal.getMemory("mem_secret1")).toBeNull();
    expect(result.memories).toBe(1);
    expect(result.excludedZone).toContain(secretRelPath);
  });

  test("an excluded-zone note never reaches recall(), even though it carries a valid ledger block", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();

    const secretRelPath = "Agent/Memory/Confidential/secret.md";
    await seedNote(git, vaultRoot, secretRelPath, "mem_secret1", "Client Jane Doe's SSN is 555-11-2222.");
    const normalRelPath = "Agent/Memory/mem_normal1.md";
    await seedNote(git, vaultRoot, normalRelPath, "mem_normal1", "User prefers dark mode.");

    await reindex({ vaultRoot, git, journal, manifest: MANIFEST, now, genId });

    const recalled = recall(journal, {}, now, MANIFEST).map((r) => r.id);
    expect(recalled).toContain("mem_normal1");
    expect(recalled).not.toContain("mem_secret1");
  });

  test("re-running reindex does not resurrect a previously-excluded note (no lingering journal row from before an override was added)", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();

    const secretRelPath = "Agent/Memory/Confidential/secret.md";
    await seedNote(git, vaultRoot, secretRelPath, "mem_secret1", "Sensitive content.");

    // Run twice -- idempotency: the note must stay excluded (not silently
    // adopted on some later pass).
    await reindex({ vaultRoot, git, journal, manifest: MANIFEST, now, genId });
    const second = await reindex({ vaultRoot, git, journal, manifest: MANIFEST, now, genId });

    expect(journal.getMemory("mem_secret1")).toBeNull();
    expect(second.excludedZone).toContain(secretRelPath);
  });

  test("a Private/** note NESTED under Agent/Memory is excluded from the walk under the BASE zone rule (no override needed)", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();

    // Base excluded zone alone (unanchored "**/Private/**", per VL-SEC-S7-03's
    // fix -- a root-anchored "Private/**" would NOT match a nested folder;
    // that's exactly what S7-03 fixed at the manifest-generation layer) --
    // proves the gate isn't override-specific, it's plain
    // resolveZone(relPath, manifest).
    const noOverrideManifest: PermissionsManifest = {
      ...MANIFEST,
      zones: { ...MANIFEST.zones, excluded: ["**/Private/**"] },
      overrides: [],
    };
    const normalRelPath = "Agent/Memory/mem_normal2.md";
    await seedNote(git, vaultRoot, normalRelPath, "mem_normal2", "Fine to index.");
    const nestedPrivateRelPath = "Agent/Memory/Private/secret3.md";
    await seedNote(git, vaultRoot, nestedPrivateRelPath, "mem_secret3", "Nested private secret.");

    const result = await reindex({ vaultRoot, git, journal, manifest: noOverrideManifest, now, genId });

    expect(journal.getMemory("mem_normal2")).not.toBeNull();
    expect(journal.getMemory("mem_secret3")).toBeNull();
    expect(result.excludedZone).toContain(nestedPrivateRelPath);
  });
});
