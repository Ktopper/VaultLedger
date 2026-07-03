import { afterEach, describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadContext } from "../src/context.js";
import { undoCommand } from "../src/commands/undo.js";
import { makeInitializedVault, type TestVault } from "./helpers.js";

let vault: TestVault;

afterEach(() => {
  vault?.cleanup();
});

describe("undoCommand", () => {
  test("undo of a remember's create txn restores state (file gone)", async () => {
    vault = await makeInitializedVault();

    const ctx = await loadContext(vault.vaultDir, vault.deps);
    const { path } = await ctx.store.remember({ content: "temp memory", reason: "test", session: "s1" });
    const abs = join(vault.vaultDir, path);
    expect(existsSync(abs)).toBe(true);

    const createTxn = ctx.journal.listTransactions({ session: "s1" }).find((t) => t.op === "create");
    ctx.db.close();
    expect(createTxn).toBeDefined();

    const messages: string[] = [];
    const result = await undoCommand(vault.vaultDir, createTxn!.id, vault.deps, {
      out: (s) => messages.push(s),
    });

    expect(result.ok).toBe(true);
    expect(existsSync(abs)).toBe(false);
  });

  test("undo of an unknown txn id reports NOT_FOUND without throwing", async () => {
    vault = await makeInitializedVault();

    const messages: string[] = [];
    const result = await undoCommand(vault.vaultDir, "txn_doesnotexist", vault.deps, {
      out: (s) => messages.push(s),
    });

    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(messages.join("\n")).toContain("NOT_FOUND");
  });

  test("session: prefix reverts every applied transaction for that session", async () => {
    vault = await makeInitializedVault();

    const ctx = await loadContext(vault.vaultDir, vault.deps);
    const { path } = await ctx.store.remember({ content: "temp memory", reason: "test", session: "s2" });
    const abs = join(vault.vaultDir, path);
    ctx.db.close();

    const result = await undoCommand(vault.vaultDir, "session:s2", vault.deps);

    expect(result.ok).toBe(true);
    expect(existsSync(abs)).toBe(false);
  });
});
