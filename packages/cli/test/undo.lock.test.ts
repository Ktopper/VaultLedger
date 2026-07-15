import { afterEach, describe, expect, test } from "vitest";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { vaultLockDir, withVaultLock } from "@vault-ledger/core";
import { loadContext } from "../src/context.js";
import { undoCommand } from "../src/commands/undo.js";
import { makeInitializedVault, type TestVault } from "./helpers.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function porcelainStatus(vaultRoot: string): string {
  return execSync("git status --porcelain", { cwd: vaultRoot, encoding: "utf8" }).trim();
}

let vault: TestVault;

afterEach(() => {
  vault?.cleanup();
});

describe("ledger undo acquires the shared vault mutation lock", () => {
  test("undo waits for an externally-held vaultLockDir lock before reverting, and lands cleanly", async () => {
    vault = await makeInitializedVault();

    // Seed a create to later undo, and grab its txn id + the config vaultId.
    const ctx = await loadContext(vault.vaultDir, vault.deps);
    const { path } = await ctx.store.remember({
      content: "temp memory\n",
      reason: "seed",
      session: "s1",
    });
    const abs = join(vault.vaultDir, path);
    const createTxn = ctx.journal
      .listTransactions({ session: "s1" })
      .find((t) => t.op === "create");
    const vaultId = ctx.config.vaultId;
    ctx.db.close();
    expect(createTxn).toBeDefined();
    expect(existsSync(abs)).toBe(true);

    // Baseline: `ledger init` does not commit .ledger/, so it starts out
    // untracked — capture that BEFORE the undo so the post-undo assertion
    // checks for no NEW dirt (a corrupted index / half-applied revert), not a
    // fully-pristine tree.
    const baseline = porcelainStatus(vault.vaultDir);

    const order: string[] = [];
    const expectedLockDir = vaultLockDir(vaultId, vault.deps.env);

    // Externally hold the SAME lock the undo path must acquire.
    const externalHold = withVaultLock(expectedLockDir, async () => {
      order.push("external-start");
      await sleep(300);
      order.push("external-end");
    });

    // Give the external holder a head start so it definitely wins the lock.
    await sleep(50);

    const undo = undoCommand(vault.vaultDir, createTxn!.id, vault.deps, {
      out: () => {},
    }).then((r) => {
      order.push("undo-end");
      return r;
    });

    const [, result] = await Promise.all([externalHold, undo]);

    // If undo ignored the lock (the bug), "undo-end" would land before
    // "external-end". Correct behavior: undo blocks until the external lock
    // releases.
    expect(order).toEqual(["external-start", "external-end", "undo-end"]);
    expect(result.ok).toBe(true);
    // The revert of the create removes the file, and the tree is clean (no
    // half-applied / index-lock corruption).
    expect(existsSync(abs)).toBe(false);
    expect(porcelainStatus(vault.vaultDir)).toBe(baseline);
  }, 10000);
});
