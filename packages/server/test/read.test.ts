import { afterEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashFile } from "@vault-ledger/core";
import { createPatch } from "diff";
import { join } from "node:path";
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

describe("read routes", () => {
  test("GET /status returns zones/mode/pendingApprovals/recentTransactions", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();
    await ctx.store.remember({ content: "# fact\n", reason: "seed", session: "s1" });

    app = buildBridge(ctx, TOKEN);
    const res = await app.inject({ method: "GET", url: "/status", headers: HEADERS });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.zones).toEqual({
      trusted: ctx.manifest.zones.trusted,
      agent: ctx.manifest.zones.agent,
      scratch: ctx.manifest.zones.scratch,
    });
    expect(body.mode).toBe(ctx.manifest.mode);
    expect(body.pendingApprovals).toBe(0);
    expect(Array.isArray(body.recentTransactions)).toBe(true);
    expect(body.recentTransactions.length).toBeGreaterThan(0);
  });

  // VL-SEC-S7-04: GET /status is the bridge route the MCP-connected agent
  // can reach over loopback. It must not leak the excluded-zone glob
  // patterns verbatim (makeTestVault's manifest sets excluded: ["Private/**"]).
  test("GET /status does not leak the excluded-zone glob pattern verbatim", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();
    expect(ctx.manifest.zones.excluded).toContain("Private/**");

    app = buildBridge(ctx, TOKEN);
    const res = await app.inject({ method: "GET", url: "/status", headers: HEADERS });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("Private/**");
    const body = res.json();
    expect(Object.prototype.hasOwnProperty.call(body.zones, "excluded")).toBe(false);
  });

  test("GET /approvals includes a non-empty rendered diff for a queued propose_edit", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();

    const abs = join(vault.vaultDir, "Notes", "trusted.md");
    const before = "# Trusted note\n\nSome content.\n";
    const after = "# Trusted note\n\nSome DIFFERENT content.\n";
    const patch = createPatch("trusted.md", before, after);
    const queued = await ctx.broker.apply({
      op: "propose_edit",
      path: "Notes/trusted.md",
      expected_hash: hashFile(abs),
      patch,
      reason: "test propose",
      session: "s1",
    });
    expect("queued" in queued && queued.queued).toBe(true);

    app = buildBridge(ctx, TOKEN);
    const res = await app.inject({ method: "GET", url: "/approvals", headers: HEADERS });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(typeof body[0].diff).toBe("string");
    expect(body[0].diff.length).toBeGreaterThan(0);
    expect(body[0].diff).toContain("DIFFERENT");
  });

  test("GET /transactions returns recorded remembers, filterable by session/entity/limit", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();
    await ctx.store.remember({ content: "# a\n", reason: "seed", session: "s1", entity: "alice" });
    await ctx.store.remember({ content: "# b\n", reason: "seed", session: "s2", entity: "bob" });

    app = buildBridge(ctx, TOKEN);
    const resAll = await app.inject({ method: "GET", url: "/transactions", headers: HEADERS });
    expect(resAll.statusCode).toBe(200);
    expect(resAll.json().length).toBe(2);

    const resFiltered = await app.inject({
      method: "GET",
      url: "/transactions?session=s1",
      headers: HEADERS,
    });
    const filtered = resFiltered.json();
    expect(filtered.length).toBe(1);
    expect(filtered[0].session).toBe("s1");
  });

  test("GET /memories filters by entity", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();
    await ctx.store.remember({ content: "# a\n", reason: "seed", session: "s1", entity: "alice" });
    await ctx.store.remember({ content: "# b\n", reason: "seed", session: "s1", entity: "bob" });

    app = buildBridge(ctx, TOKEN);
    const res = await app.inject({ method: "GET", url: "/memories?entity=alice", headers: HEADERS });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.length).toBe(1);
    expect(body[0].entity).toBe("alice");
  });

  test("GET /staleness flags a working memory not referenced within stalenessDays", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();

    const { id } = await ctx.store.remember({ content: "# stale\n", reason: "seed", session: "s1" });
    // Bypass promote's approval gate (that's not what's under test here) —
    // directly flip the journal row to "working" with a long-past
    // last_referenced so it's well outside the default stalenessDays window.
    ctx.journal.updateMemory(id, { status: "working", last_referenced: "2000-01-01T00:00:00.000Z" });

    app = buildBridge(ctx, TOKEN);
    const res = await app.inject({ method: "GET", url: "/staleness", headers: HEADERS });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((m: { id: string }) => m.id === id)).toBe(true);
  });

  test("GET /conflicts returns an empty array (v0.3 populates)", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();

    app = buildBridge(ctx, TOKEN);
    const res = await app.inject({ method: "GET", url: "/conflicts", headers: HEADERS });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
