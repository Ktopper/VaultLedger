import { afterEach, describe, expect, test } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

  test("prints a loud warning when reindex finds an out-of-broker canonical elevation", async () => {
    vault = await makeInitializedVault();

    const ctx = await loadContext(vault.vaultDir, vault.deps);
    const { id, path } = await ctx.store.remember({
      content: "z",
      reason: "test",
      session: "s1",
    });
    await ctx.store.promote({ id, target_status: "working", reason: "confirmed", session: "s1" });

    // Out-of-band edit: flip ledger.status to canonical directly on disk
    // (a plain string substitution, no YAML re-serialization needed), bypassing
    // the broker/approval gate entirely.
    const abs = join(ctx.vaultRoot, path);
    const raw = readFileSync(abs, "utf8");
    expect(raw).toContain("status: working");
    writeFileSync(abs, raw.replace("status: working", "status: canonical"), "utf8");
    ctx.db.close();

    const messages: string[] = [];
    const result = await reindexCommand(vault.vaultDir, vault.deps, { out: (s) => messages.push(s) });

    expect(result.elevatedToCanonical).toContain(path);
    expect(messages.some((m) => m.includes("elevated to canonical") && m.includes(path))).toBe(
      true,
    );
  });

  test("prints no warning on a clean vault with no out-of-band elevation", async () => {
    vault = await makeInitializedVault();

    const ctx = await loadContext(vault.vaultDir, vault.deps);
    await ctx.store.remember({ content: "clean", reason: "test", session: "s1" });
    ctx.db.close();

    const messages: string[] = [];
    await reindexCommand(vault.vaultDir, vault.deps, { out: (s) => messages.push(s) });

    expect(messages.some((m) => m.toLowerCase().includes("elevated"))).toBe(false);
  });
});
