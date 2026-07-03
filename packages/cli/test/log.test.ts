import { afterEach, describe, expect, test } from "vitest";
import { loadContext } from "../src/context.js";
import { logCommand } from "../src/commands/log.js";
import { makeInitializedVault, type TestVault } from "./helpers.js";

let vault: TestVault;

afterEach(() => {
  vault?.cleanup();
});

describe("logCommand", () => {
  test("returns 2+ rows after two remembers", async () => {
    vault = await makeInitializedVault();

    const ctx = await loadContext(vault.vaultDir, vault.deps);
    await ctx.store.remember({ content: "first", reason: "test", session: "session-a" });
    await ctx.store.remember({ content: "second", reason: "test", session: "session-b" });
    ctx.db.close();

    const rows = await logCommand(vault.vaultDir, {}, vault.deps);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  test("session filter narrows the results", async () => {
    vault = await makeInitializedVault();

    const ctx = await loadContext(vault.vaultDir, vault.deps);
    await ctx.store.remember({ content: "first", reason: "test", session: "session-a" });
    await ctx.store.remember({ content: "second", reason: "test", session: "session-b" });
    ctx.db.close();

    const rows = await logCommand(vault.vaultDir, { session: "session-a" }, vault.deps);
    expect(rows.length).toBe(1);
    expect(rows[0]?.session).toBe("session-a");
  });
});
