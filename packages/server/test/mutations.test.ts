import { afterEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPatch } from "diff";
import { hashBytes, hashFile } from "@vault-ledger/core";
import { buildBridge } from "../src/app.js";
import { makeTestVault, openTestVault, type TestVault } from "./helpers.js";

const TOKEN = "test-token-123";
const HEADERS = { host: "127.0.0.1:51789", authorization: `Bearer ${TOKEN}` };
const JSON_HEADERS = { ...HEADERS, "content-type": "application/json" };

// makeTestVault's default Notes/trusted.md is only 3 lines — a one-word
// substitution against it trips the broker's PATCH_TOO_LARGE guard (the
// changed-line/byte ratio exceeds the default 50% threshold on a file that
// small). Pad it out first so a small, realistic single-word edit stays
// comfortably under threshold when the queued approval is actually applied.
const PADDED_NOTE =
  "# Trusted note\n\n" +
  "Filler line 1.\nFiller line 2.\nFiller line 3.\nFiller line 4.\nFiller line 5.\n" +
  "Some content.\n";

let vault: TestVault | undefined;
let app: FastifyInstance | undefined;
let closeCtx: (() => void) | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  if (closeCtx) {
    closeCtx();
    closeCtx = undefined;
  }
  if (vault) {
    vault.cleanup();
    vault = undefined;
  }
});

describe("mutation routes", () => {
  test("POST /approvals/:id/approve applies a queued propose_edit and changes the file", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();

    const abs = join(vault.vaultDir, "Notes", "trusted.md");
    writeFileSync(abs, PADDED_NOTE, "utf8");
    const before = readFileSync(abs, "utf8");
    const after = before.replace("Some content.", "Some DIFFERENT content.");
    const patch = createPatch("trusted.md", before, after);
    const queued = await ctx.broker.apply({
      op: "propose_edit",
      path: "Notes/trusted.md",
      expected_hash: hashFile(abs),
      patch,
      reason: "test propose",
      session: "s1",
    });
    if (!("queued" in queued) || !queued.queued) throw new Error("expected queued");

    app = buildBridge(ctx, TOKEN);
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${queued.approvalId}/approve`,
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: true });
    expect(readFileSync(abs, "utf8")).toBe(after);
  });

  test("POST /approvals/:id/approve returns {stale:true} when the file changed under the queued edit", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();

    const abs = join(vault.vaultDir, "Notes", "trusted.md");
    writeFileSync(abs, PADDED_NOTE, "utf8");
    const before = readFileSync(abs, "utf8");
    const patch = createPatch("trusted.md", before, before.replace("Some content.", "Some DIFFERENT content."));
    const queued = await ctx.broker.apply({
      op: "propose_edit",
      path: "Notes/trusted.md",
      expected_hash: hashFile(abs),
      patch,
      reason: "test propose",
      session: "s1",
    });
    if (!("queued" in queued) || !queued.queued) throw new Error("expected queued");

    // Mutate the file out from under the queued approval (bypassing the
    // broker) so its expected_hash goes stale before the approval runs.
    writeFileSync(abs, before + "\nSomeone else edited this first.\n", "utf8");

    app = buildBridge(ctx, TOKEN);
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${queued.approvalId}/approve`,
      headers: JSON_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stale: true });
  });

  test("POST /approvals/:id/reject leaves the file unchanged", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();

    const abs = join(vault.vaultDir, "Notes", "trusted.md");
    writeFileSync(abs, PADDED_NOTE, "utf8");
    const before = readFileSync(abs, "utf8");
    const patch = createPatch("trusted.md", before, before.replace("Some content.", "Some DIFFERENT content."));
    const queued = await ctx.broker.apply({
      op: "propose_edit",
      path: "Notes/trusted.md",
      expected_hash: hashFile(abs),
      patch,
      reason: "test propose",
      session: "s1",
    });
    if (!("queued" in queued) || !queued.queued) throw new Error("expected queued");

    app = buildBridge(ctx, TOKEN);
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${queued.approvalId}/reject`,
      headers: JSON_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ rejected: true });
    expect(readFileSync(abs, "utf8")).toBe(before);
  });

  test("POST /undo on a create transaction reverts it and removes the file", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();

    const { path, txnId } = await ctx.store.remember({
      content: "# to be undone\n",
      reason: "seed",
      session: "s1",
    });
    const abs = join(vault.vaultDir, path);
    expect(existsSync(abs)).toBe(true);

    app = buildBridge(ctx, TOKEN);
    const res = await app.inject({
      method: "POST",
      url: "/undo",
      headers: JSON_HEADERS,
      payload: { target: txnId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.revertSha).toBe("string");
    expect(typeof body.revertTxnId).toBe("string");
    expect(existsSync(abs)).toBe(false);
  });

  test("POST /undo on an unknown transaction returns 404 with a typed error body", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();

    app = buildBridge(ctx, TOKEN);
    const res = await app.inject({
      method: "POST",
      url: "/undo",
      headers: JSON_HEADERS,
      payload: { target: "txn_does_not_exist" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  test("POST /undo surfaces a REVERT_CONFLICT as 409", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();

    const original = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n";
    const createResult = await ctx.broker.apply({
      op: "create",
      path: "Agent/Memory/conf.md",
      content: original,
      reason: "seed",
      session: "s1",
    });
    if (!createResult.ok || "queued" in createResult) throw new Error("expected applied");

    // A second revise changes a line the create introduced, so reverting the
    // create (a delete of the file as it was at the create) now conflicts
    // with HEAD's independently-modified version.
    const changed = "alpha\nBETA\ngamma\ndelta\nepsilon\nzeta\n";
    const patchText = createPatch("conf.md", original, changed);
    await ctx.broker.apply({
      op: "revise",
      path: "Agent/Memory/conf.md",
      expected_hash: hashBytes(Buffer.from(original, "utf8")),
      patch: patchText,
      reason: "conflict maker",
      session: "s1",
    });

    app = buildBridge(ctx, TOKEN);
    const res = await app.inject({
      method: "POST",
      url: "/undo",
      headers: JSON_HEADERS,
      payload: { target: createResult.txnId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "REVERT_CONFLICT" } });
  });
});
