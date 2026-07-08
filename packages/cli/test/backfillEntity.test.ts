import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatMessage } from "@vaultledger/core";
import { loadContext } from "../src/context.js";
import { backfillEntityCommand } from "../src/commands/backfillEntity.js";
import { makeInitializedVault, type TestVault } from "./helpers.js";

let vault: TestVault;

afterEach(() => {
  vault?.cleanup();
});

describe("backfillEntityCommand", () => {
  test("clean vault (nothing to do) prints zeros", async () => {
    vault = await makeInitializedVault();
    const ctx = await loadContext(vault.vaultDir, vault.deps);
    await ctx.store.remember({
      content: "already self-describing",
      entity: "nova",
      reason: "seed",
      session: "s1",
    });
    ctx.db.close();

    const messages: string[] = [];
    const result = await backfillEntityCommand(vault.vaultDir, vault.deps, {
      out: (s) => messages.push(s),
    });

    expect(result.backfilled).toBe(0);
    expect(result.mismatched).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(messages).toContain("backfilled=0 skipped=1");
  });

  test("backfills a legacy note and lists a mismatch", async () => {
    vault = await makeInitializedVault();
    const ctx = await loadContext(vault.vaultDir, vault.deps);

    // Legacy note: file has NO top-level entity; journal already knows "nova".
    const legacyRel = "Agent/Memory/mem_legacy.md";
    mkdirSync(join(ctx.vaultRoot, "Agent/Memory"), { recursive: true });
    // NOTE: no top-level `entity:` -- the pre-fix note shape (see
    // core's reindex.test.ts seedLegacyNoteNoEntity, which this mirrors, but
    // spelled out as a raw string here since the CLI package has no direct
    // gray-matter dependency).
    const legacyBody = `---
ledger:
  id: mem_legacy
  status: working
  created: '${ctx.now()}'
  source: s1
  reason: seed
  confidence: medium
  supersedes: null
  expires: null
---

Legacy body.
`;
    writeFileSync(join(ctx.vaultRoot, legacyRel), legacyBody, "utf8");
    await ctx.git.commitFile(
      legacyRel,
      formatMessage({ op: "create", basename: "mem_legacy.md", memoryId: "mem_legacy", session: "s1" }),
    );
    ctx.journal.insertMemory({
      id: "mem_legacy",
      path: legacyRel,
      entity: "nova",
      status: "working",
      confidence: "medium",
      created: ctx.now(),
      source: "s1",
      supersedes: null,
      expires: null,
      last_referenced: null,
    });

    // A note whose file entity ("bob") disagrees with a doctored journal
    // entity ("nova") -- simulates drift/residue that must be flagged, not
    // silently resolved.
    const { id: mismatchId, path: mismatchPath } = await ctx.store.remember({
      content: "mismatch body",
      entity: "bob",
      reason: "seed",
      session: "s1",
    });
    ctx.journal.updateMemory(mismatchId, { entity: "nova" });

    ctx.db.close();

    const messages: string[] = [];
    const result = await backfillEntityCommand(vault.vaultDir, vault.deps, {
      out: (s) => messages.push(s),
    });

    expect(result.backfilled).toBe(1);
    expect(result.mismatched).toHaveLength(1);
    expect(result.mismatched[0]).toMatchObject({
      path: mismatchPath,
      fileEntity: "bob",
      journalEntity: "nova",
    });
    expect(result.errors).toEqual([]);

    expect(messages.some((m) => m.startsWith("backfilled=1 skipped="))).toBe(true);
    expect(
      messages.some(
        (m) => m.includes("mismatch:") && m.includes(mismatchPath) && m.includes("file=bob") && m.includes("journal=nova"),
      ),
    ).toBe(true);

    const raw = readFileSync(join(ctx.vaultRoot, legacyRel), "utf8");
    expect(raw).toMatch(/^entity: nova$/m);
  });
});
