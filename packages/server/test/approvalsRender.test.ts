import { afterEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashFile } from "@vault-ledger/core";
import { buildBridge } from "../src/app.js";
import { makeTestVault, openTestVault, type TestVault } from "./helpers.js";

const TOKEN = "test-token-123";
const HEADERS = { host: "127.0.0.1:51789", authorization: `Bearer ${TOKEN}` };

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

// The seeded note the test vault ships with (helpers.ts). Its bytes
// ("# Trusted note\n\nSome content.\n") are what a delete renders against.
const TRUSTED = "Notes/trusted.md";

describe("GET /approvals — delete/move render (WU-6, N1)", () => {
  test("a queued propose_delete renders the DELETE header + full content as removal lines", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();

    const res = await ctx.broker.apply({
      op: "propose_delete",
      path: TRUSTED,
      expected_hash: hashFile(join(vault.vaultDir, TRUSTED)),
      reason: "retire the note",
      session: "s1",
    });
    if (!res.ok || !("queued" in res) || !res.queued) throw new Error("expected a queued delete");

    app = buildBridge(ctx, TOKEN);
    const httpRes = await app.inject({ method: "GET", url: "/approvals", headers: HEADERS });
    expect(httpRes.statusCode).toBe(200);
    const [row] = httpRes.json();
    expect(row.diff).toContain(`DELETE ${TRUSTED}`);
    expect(row.diff).toContain("-# Trusted note");
    expect(row.diff).toContain("-Some content.");
  });

  test("N1: a queued delete whose source vanished renders an `unavailable` marker, not a 500", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();

    const res = await ctx.broker.apply({
      op: "propose_delete",
      path: TRUSTED,
      expected_hash: hashFile(join(vault.vaultDir, TRUSTED)),
      reason: "retire the note",
      session: "s1",
    });
    if (!res.ok || !("queued" in res) || !res.queued) throw new Error("expected a queued delete");

    // Source removed out from under the pending approval — the render read now
    // fails. The route must still 200 with a marker for the row.
    rmSync(join(vault.vaultDir, TRUSTED), { force: true });

    app = buildBridge(ctx, TOKEN);
    const httpRes = await app.inject({ method: "GET", url: "/approvals", headers: HEADERS });
    expect(httpRes.statusCode).toBe(200);
    const [row] = httpRes.json();
    expect(row.diff).toBe(`— ${TRUSTED} unavailable`);
  });

  test("N1: a queued delete of an over-cap source renders the marker, not a 500", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();

    // Grow the source past the 64 KiB render cap, then pin the delete to its
    // new hash so the propose gate accepts it.
    const abs = join(vault.vaultDir, TRUSTED);
    writeFileSync(abs, "x".repeat(65 * 1024), "utf8");
    const res = await ctx.broker.apply({
      op: "propose_delete",
      path: TRUSTED,
      expected_hash: hashFile(abs),
      reason: "retire the big note",
      session: "s1",
    });
    if (!res.ok || !("queued" in res) || !res.queued) throw new Error("expected a queued delete");

    app = buildBridge(ctx, TOKEN);
    const httpRes = await app.inject({ method: "GET", url: "/approvals", headers: HEADERS });
    expect(httpRes.statusCode).toBe(200);
    const [row] = httpRes.json();
    expect(row.diff).toBe(`— ${TRUSTED} unavailable`);
  });

  test("a queued propose_move renders `MOVE from -> to`", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();

    const res = await ctx.broker.apply({
      op: "propose_move",
      from: TRUSTED,
      to: "Notes/renamed.md",
      expected_hash: hashFile(join(vault.vaultDir, TRUSTED)),
      reason: "rename the note",
      session: "s1",
    });
    if (!res.ok || !("queued" in res) || !res.queued) throw new Error("expected a queued move");

    app = buildBridge(ctx, TOKEN);
    const httpRes = await app.inject({ method: "GET", url: "/approvals", headers: HEADERS });
    expect(httpRes.statusCode).toBe(200);
    const [row] = httpRes.json();
    expect(row.diff).toBe(`MOVE ${TRUSTED} -> Notes/renamed.md`);
  });
});
