import { afterEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journalPath, openJournal, permissionsPath, readConfig } from "@vaultledger/core";
import { loadContext } from "../src/context.js";
import { statusCommand } from "../src/commands/status.js";
import { logCommand } from "../src/commands/log.js";
import { makeInitializedVault, type TestVault } from "./helpers.js";

let vault: TestVault;

afterEach(() => {
  vault?.cleanup();
});

function commitCount(dir: string): number {
  const out = execFileSync("git", ["-C", dir, "rev-list", "--count", "HEAD"], {
    encoding: "utf8",
  });
  return Number.parseInt(out.trim(), 10);
}

describe("loadContext handle safety", () => {
  test("closes the sqlite handle when post-open work throws", async () => {
    vault = await makeInitializedVault();

    // Create a ledger commit + memory, then wipe the journal so the next
    // loadContext's ensureJournal->reindex must recover the transaction from
    // the commit — which calls genId. An exploding genId makes reindex throw
    // AFTER the journal handle is open, exercising the cleanup path.
    const seed = await loadContext(vault.vaultDir, vault.deps);
    await seed.store.remember({ content: "seed", reason: "test", session: "s1" });
    seed.db.close();

    const config = readConfig(vault.vaultDir);
    const dbPath = journalPath(config.vaultId, vault.deps.env);
    rmSync(dbPath, { force: true });

    // Spy on the better-sqlite3 Database prototype's close so we can assert the
    // handle opened INSIDE loadContext is actually closed on the failure path —
    // a plain "error propagates + reopen works" check passes even without the
    // fix (better-sqlite3 allows independent reopens), so it wouldn't be red.
    const sample = openJournal(":memory:");
    const proto = Object.getPrototypeOf(sample) as { close: () => unknown };
    sample.close();
    const closeSpy = vi.spyOn(proto, "close");

    const explodingGenId = () => {
      throw new Error("boom");
    };
    try {
      await expect(
        loadContext(vault.vaultDir, { ...vault.deps, genId: explodingGenId }),
      ).rejects.toThrow("boom");
      // The db opened during the failed load must have been closed by
      // loadContext's cleanup (not left leaking).
      expect(closeSpy).toHaveBeenCalled();
    } finally {
      closeSpy.mockRestore();
    }

    // And a fresh open of the same path still works and is usable.
    const reopened = openJournal(dbPath);
    expect(() => reopened.prepare("SELECT 1").get()).not.toThrow();
    reopened.close();
  });
});

describe("read-only commands never mutate the vault", () => {
  test("status does not sweep an expired scratch memory (no new commit, file stays)", async () => {
    vault = await makeInitializedVault();

    // Remember with a far-past clock so the scratch memory is well beyond the
    // default 14-day TTL by the time a later command loads the vault.
    const oldNow = () => "2020-01-01T00:00:00.000Z";
    const ctx = await loadContext(vault.vaultDir, { ...vault.deps, now: oldNow });
    const { path } = await ctx.store.remember({ content: "old memory", reason: "test", session: "s1" });
    ctx.db.close();

    const abs = join(vault.vaultDir, path);
    expect(existsSync(abs)).toBe(true);
    const before = commitCount(vault.vaultDir);

    await statusCommand(vault.vaultDir, vault.deps);

    expect(commitCount(vault.vaultDir)).toBe(before);
    expect(existsSync(abs)).toBe(true);
  });

  test("log does not sweep an expired scratch memory (no new commit, file stays)", async () => {
    vault = await makeInitializedVault();

    const oldNow = () => "2020-01-01T00:00:00.000Z";
    const ctx = await loadContext(vault.vaultDir, { ...vault.deps, now: oldNow });
    const { path } = await ctx.store.remember({ content: "old memory", reason: "test", session: "s1" });
    ctx.db.close();

    const abs = join(vault.vaultDir, path);
    const before = commitCount(vault.vaultDir);

    await logCommand(vault.vaultDir, {}, vault.deps);

    expect(commitCount(vault.vaultDir)).toBe(before);
    expect(existsSync(abs)).toBe(true);
  });
});

describe("friendly errors", () => {
  test("uninitialized dir yields the friendly not-a-vault message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vl-uninit-"));
    try {
      await expect(statusCommand(dir)).rejects.toThrow(/not a VaultLedger vault/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing permissions.yaml yields a friendly error, not a raw ENOENT/zod stack", async () => {
    vault = await makeInitializedVault();
    rmSync(permissionsPath(vault.vaultDir), { force: true });

    let thrown: unknown;
    try {
      await loadContext(vault.vaultDir, vault.deps);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    // Friendly, actionable message — not a raw fs/zod stack.
    expect(message).toMatch(/permissions file missing or corrupt/i);
    expect(message).toContain("ledger init");
    expect(message).not.toContain("ENOENT");
  });
});
