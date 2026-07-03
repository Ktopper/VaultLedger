import { afterEach, describe, expect, test } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { journalPath, readConfig } from "@vaultledger/core";
import { loadContext } from "../src/context.js";
import { reindexCommand } from "../src/commands/reindex.js";
import { makeInitializedVault, type TestVault } from "./helpers.js";

let vault: TestVault;

afterEach(() => {
  vault?.cleanup();
});

describe("reindexCommand", () => {
  test("returns counts on a freshly initialized (empty) vault", async () => {
    vault = await makeInitializedVault();

    const result = await reindexCommand(vault.vaultDir, vault.deps);

    expect(result.memories).toBe(0);
    expect(result.transactions).toBe(0);
    expect(result.skipped).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  test("rebuilds the journal from disk + git after the journal.db is wiped", async () => {
    vault = await makeInitializedVault();

    const ctx = await loadContext(vault.vaultDir, vault.deps);
    await ctx.store.remember({ content: "remember me", reason: "test", session: "s1" });
    ctx.db.close();

    const config = readConfig(vault.vaultDir);
    const dbPath = journalPath(config.vaultId, vault.deps.env);
    expect(existsSync(dbPath)).toBe(true);
    rmSync(dbPath, { force: true });

    const result = await reindexCommand(vault.vaultDir, vault.deps);
    expect(result.memories).toBeGreaterThan(0);
  });
});
