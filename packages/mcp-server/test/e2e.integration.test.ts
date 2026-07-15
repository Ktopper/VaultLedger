import { afterEach, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPatch } from "diff";
import { undoSession, UNSAFE_NO_LOCK } from "@vault-ledger/core";
import { loadServerContext, type ServerContext } from "../src/context.js";
import { createServer } from "../src/index.js";
import { makeTestVault, type TestVault } from "./helpers.js";

let vault: TestVault;
let ctx: ServerContext;

afterEach(() => {
  ctx?.db.close();
  vault?.cleanup();
});

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

/**
 * Handler-level integration test (not a real stdio subprocess): builds the
 * server/tool registry from `createServer` over a fixture vault and drives
 * remember -> recall -> revise -> undo through the exact `callTool` dispatch
 * a real CallTool JSON-RPC request would hit, then finishes the cycle by
 * calling core's `undoTransaction` directly (undo isn't a tool in the v0.1
 * spec surface) and confirming recall no longer finds the memory. Chosen
 * over spawning the built binary for determinism, per the phase brief.
 */
describe("MCP server integration: remember -> recall -> revise -> undo", () => {
  test("full cycle", async () => {
    vault = await makeTestVault();
    const { now, genId } = makeClock();
    ctx = await loadServerContext(vault.vaultDir, {
      ...vault.deps,
      now,
      genId,
      session: "mcp-e2e-session",
    });
    const { callTool } = createServer(ctx);

    // remember
    const rememberResult = await callTool("memory_remember", {
      content: "Bob prefers tabs over spaces.",
      entity: "bob",
      reason: "user stated a preference",
      tags: ["preference"],
    });
    expect(rememberResult.isError).toBeFalsy();
    const remembered = JSON.parse(rememberResult.content[0]!.text as string) as {
      id: string;
      path: string;
    };
    expect(typeof remembered.id).toBe("string");

    // recall
    const recallResult = await callTool("memory_recall", { entity: "bob" });
    expect(recallResult.isError).toBeFalsy();
    const recalled = JSON.parse(recallResult.content[0]!.text as string) as {
      memories: Array<{ id: string }>;
    };
    expect(recalled.memories.some((m) => m.id === remembered.id)).toBe(true);

    // revise
    const abs = join(vault.vaultDir, remembered.path);
    const before = readFileSync(abs, "utf8");
    const after = before + "\nAlso prefers 2-space indents.";
    const patch = createPatch(remembered.path, before, after);
    const reviseResult = await callTool("memory_revise", {
      id: remembered.id,
      patch,
      reason: "add detail",
    });
    expect(reviseResult.isError).toBeFalsy();
    const revised = JSON.parse(reviseResult.content[0]!.text as string) as { revised: boolean };
    expect(revised.revised).toBe(true);
    expect(readFileSync(abs, "utf8")).toContain("2-space indents");

    // undo (not a tool in the v0.1 spec surface — call core directly). The
    // session now has two applied transactions (create, then revise) against
    // the same file; undoSession reverts every applied transaction for the
    // session in reverse-chronological order (revise first, then create) —
    // reverting the create commit FIRST would conflict at the git level
    // (it tries to delete a file a later commit modified), so this order
    // matters and is exactly what core's undoSession guarantees.
    const reverted = await undoSession(
      { git: ctx.git, journal: ctx.journal, now: ctx.now, genId: ctx.genId, lockDir: UNSAFE_NO_LOCK },
      "mcp-e2e-session",
    );
    expect(reverted.length).toBe(2);

    // recall again: the memory is now reverted, excluded from a bare recall.
    const recallAfterUndo = await callTool("memory_recall", { entity: "bob" });
    const recalledAfterUndo = JSON.parse(recallAfterUndo.content[0]!.text as string) as {
      memories: Array<{ id: string }>;
    };
    expect(recalledAfterUndo.memories.some((m) => m.id === remembered.id)).toBe(false);
  });
});
