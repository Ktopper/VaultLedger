import { afterEach, describe, expect, test } from "vitest";
import { execSync } from "node:child_process";
import { vaultLockDir, withVaultLock } from "@vault-ledger/core";
import { loadServerContext } from "../src/context.js";
import { makeTestVault, type TestVault } from "./helpers.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countLedgerCommits(vaultRoot: string): number {
  const log = execSync("git log --format=%s", { cwd: vaultRoot, encoding: "utf8" });
  return log.split("\n").filter((line) => line.startsWith("ledger:")).length;
}

function porcelainStatus(vaultRoot: string): string {
  return execSync("git status --porcelain", { cwd: vaultRoot, encoding: "utf8" }).trim();
}

let vault: TestVault;

afterEach(() => {
  vault?.cleanup();
});

describe("loadServerContext acquires the shared vault mutation lock", () => {
  test("the Broker's lockDir is exactly vaultLockDir(vaultId, env): pre-holding that lock externally blocks a mutation until released", async () => {
    vault = await makeTestVault();
    const ctx = await loadServerContext(vault.vaultDir, { ...vault.deps, session: "s1" });
    try {
      const order: string[] = [];
      const expectedLockDir = vaultLockDir(ctx.config.vaultId, vault.deps.env);

      const externalHold = withVaultLock(expectedLockDir, async () => {
        order.push("external-start");
        await sleep(300);
        order.push("external-end");
      });

      // Give the external holder a head start so it definitely wins the lock.
      await sleep(50);

      const mutation = ctx.store
        .remember({ content: "# note\n", reason: "lock test", session: "s1" })
        .then((r) => {
          order.push("mutate-end");
          return r;
        });

      await Promise.all([externalHold, mutation]);

      // If the Broker were NOT using this exact lockDir, the mutation would
      // have run immediately and "mutate-end" would appear before
      // "external-end" — this ordering is the functional proof of lockDir
      // equality.
      expect(order).toEqual(["external-start", "external-end", "mutate-end"]);
    } finally {
      ctx.db.close();
    }
  }, 10000);

  test("REAL two-process simulation: two server contexts loaded via loadServerContext over the SAME vault serialize concurrent mutations cleanly", async () => {
    vault = await makeTestVault();

    const ctxA = await loadServerContext(vault.vaultDir, { ...vault.deps, session: "sA" });
    const ctxB = await loadServerContext(vault.vaultDir, { ...vault.deps, session: "sB" });

    // Baseline: makeTestVault only `git init`s (no initial commit), so
    // Notes/Private/.ledger start out untracked — capture that BEFORE the
    // mutations so the post-mutation assertion checks for no NEW dirt (a
    // corrupted index, a half-applied move, etc.), not a fully-clean tree.
    const baseline = porcelainStatus(vault.vaultDir);

    try {
      const [resultA, resultB] = await Promise.all([
        ctxA.store.remember({ content: "# from A\n", reason: "two-process test A", session: "sA" }),
        ctxB.store.remember({ content: "# from B\n", reason: "two-process test B", session: "sB" }),
      ]);

      expect(resultA.id).toBeDefined();
      expect(resultB.id).toBeDefined();
      expect(resultA.path).not.toBe(resultB.path);

      expect(porcelainStatus(vault.vaultDir)).toBe(baseline);
      expect(countLedgerCommits(vault.vaultDir)).toBe(2);

      // Both connections point at the SAME journal.db file — either should see
      // both transactions consistently (no split-brain / lost write).
      const txnsFromA = ctxA.journal.listTransactions({});
      const txnsFromB = ctxB.journal.listTransactions({});
      expect(txnsFromA.length).toBe(2);
      expect(txnsFromB.length).toBe(2);
    } finally {
      ctxA.db.close();
      ctxB.db.close();
    }
  }, 15000);
});
