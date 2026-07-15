import { afterEach, describe, expect, test } from "vitest";
import { vaultLockDir, withVaultLock } from "@vault-ledger/core";
import { loadContext } from "../src/context.js";
import { makeInitializedVault, type TestVault } from "./helpers.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let vault: TestVault;

afterEach(() => {
  vault?.cleanup();
});

describe("loadContext acquires the shared vault mutation lock", () => {
  test("the Broker's lockDir is exactly vaultLockDir(vaultId, env): pre-holding that lock externally blocks a mutation until released", async () => {
    vault = await makeInitializedVault();
    const ctx = await loadContext(vault.vaultDir, vault.deps);
    try {
      const order: string[] = [];
      const expectedLockDir = vaultLockDir(ctx.config.vaultId, vault.deps.env);

      const externalHold = withVaultLock(expectedLockDir, async () => {
        order.push("external-start");
        await sleep(300);
        order.push("external-end");
      });

      await sleep(50);

      const mutation = ctx.store
        .remember({ content: "# note\n", reason: "lock test", session: "s1" })
        .then((r) => {
          order.push("mutate-end");
          return r;
        });

      await Promise.all([externalHold, mutation]);

      // If loadContext did NOT pass this exact lockDir into the Broker, the
      // mutation would run immediately and "mutate-end" would appear before
      // "external-end".
      expect(order).toEqual(["external-start", "external-end", "mutate-end"]);
    } finally {
      ctx.db.close();
    }
  }, 10000);
});
