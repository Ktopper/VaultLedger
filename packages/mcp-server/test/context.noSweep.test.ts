import { afterEach, describe, expect, test } from "vitest";
import { loadServerContext } from "../src/context.js";
import { makeTestVault, type TestVault } from "./helpers.js";

let vault: TestVault;

afterEach(() => {
  vault?.cleanup();
});

/**
 * `skipSweep` is the `--no-sweep` flag's context.ts-level seam: a smoke
 * check that spawns the real server must be able to verify the server
 * without the startup TTL sweep mutating the vault (archiving expired
 * scratch) as a side effect.
 */
describe("loadServerContext skipSweep", () => {
  test("skipSweep: true leaves an expired scratch memory un-archived", async () => {
    vault = await makeTestVault();

    // Seed a scratch memory whose `created` is far past the default 14-day
    // ttlDays, using the seeding session's own injected clock.
    const oldNow = () => "2020-01-01T00:00:00.000Z";
    const seed = await loadServerContext(vault.vaultDir, { ...vault.deps, now: oldNow, session: "s1" });
    const { id } = await seed.store.remember({ content: "old scratch", reason: "seed", session: "s1" });
    seed.db.close();

    const now = () => "2026-07-03T00:00:00.000Z";
    const ctx = await loadServerContext(vault.vaultDir, {
      ...vault.deps,
      now,
      session: "s2",
      skipSweep: true,
    });
    try {
      expect(ctx.journal.getMemory(id)!.status).toBe("scratch");
    } finally {
      ctx.db.close();
    }
  });

  test("skipSweep omitted (default false): the expired scratch memory IS archived", async () => {
    vault = await makeTestVault();

    const oldNow = () => "2020-01-01T00:00:00.000Z";
    const seed = await loadServerContext(vault.vaultDir, { ...vault.deps, now: oldNow, session: "s1" });
    const { id } = await seed.store.remember({ content: "old scratch", reason: "seed", session: "s1" });
    seed.db.close();

    const now = () => "2026-07-03T00:00:00.000Z";
    const ctx = await loadServerContext(vault.vaultDir, { ...vault.deps, now, session: "s2" });
    try {
      expect(ctx.journal.getMemory(id)!.status).toBe("forgotten");
    } finally {
      ctx.db.close();
    }
  });
});
