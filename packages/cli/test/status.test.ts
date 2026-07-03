import { afterEach, describe, expect, test } from "vitest";
import { loadContext } from "../src/context.js";
import { statusCommand } from "../src/commands/status.js";
import { makeInitializedVault, type TestVault } from "./helpers.js";

let vault: TestVault;

afterEach(() => {
  vault?.cleanup();
});

describe("statusCommand", () => {
  test("returns zones + empty arrays on a freshly initialized vault", async () => {
    vault = await makeInitializedVault();

    const result = await statusCommand(vault.vaultDir, vault.deps);

    expect(result.zones.agent).toContain("Agent/**");
    expect(result.pendingApprovals).toEqual([]);
    expect(result.recentTransactions).toEqual([]);
  });

  test("recentTransactions is non-empty after a remember", async () => {
    vault = await makeInitializedVault();

    const ctx = await loadContext(vault.vaultDir, vault.deps);
    await ctx.store.remember({ content: "hello world", reason: "test", session: "s1" });
    ctx.db.close();

    const result = await statusCommand(vault.vaultDir, vault.deps);
    expect(result.recentTransactions.length).toBeGreaterThan(0);
  });
});
