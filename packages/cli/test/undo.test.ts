import { afterEach, describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createPatch } from "diff";
import { hashBytes } from "@vault-ledger/core";
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

  test("REVERT_CONFLICT: returns { ok:false, code } without throwing", async () => {
    vault = await makeInitializedVault();

    const ctx = await loadContext(vault.vaultDir, vault.deps);
    const relPath = "Agent/Memory/conf.md";
    const original = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n";
    const createResult = await ctx.broker.apply({
      op: "create",
      path: relPath,
      content: original,
      reason: "seed",
      session: "s1",
    });
    if (!createResult.ok || "queued" in createResult || createResult.txnId === undefined) {
      throw new Error("expected an applied create with a txnId");
    }

    // A later commit modifies a line the create introduced, so reverting the
    // create (delete-the-file) now conflicts with HEAD's modified version.
    const changed = "alpha\nBETA\ngamma\ndelta\nepsilon\nzeta\n";
    await ctx.broker.apply({
      op: "revise",
      path: relPath,
      expected_hash: hashBytes(Buffer.from(original, "utf8")),
      patch: createPatch("conf.md", original, changed),
      reason: "conflict maker",
      session: "s1",
    });
    const createTxnId = createResult.txnId;
    ctx.db.close();

    const messages: string[] = [];
    const result = await undoCommand(vault.vaultDir, createTxnId, vault.deps, {
      out: (s) => messages.push(s),
    });

    expect(result).toEqual({ ok: false, code: "REVERT_CONFLICT" });
    expect(messages.join("\n")).toContain("REVERT_CONFLICT");
  });
});
