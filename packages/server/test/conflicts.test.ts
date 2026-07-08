import { afterEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ConflictRow, MemoryRow } from "@vaultledger/core";
import { buildBridge } from "../src/app.js";
import { makeTestVault, openTestVault, type TestVault } from "./helpers.js";

const TOKEN = "test-token-123";
const HEADERS = { host: "127.0.0.1:51789", authorization: `Bearer ${TOKEN}` };
const JSON_HEADERS = { ...HEADERS, "content-type": "application/json" };

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

function memRow(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: "mem_a",
    path: "mem_a.md",
    entity: "nova",
    status: "canonical",
    confidence: "high",
    created: "2026-07-01T00:00:00.000Z",
    source: "chat",
    supersedes: null,
    expires: null,
    last_referenced: null,
    ...overrides,
  };
}

function conflictRow(overrides: Partial<ConflictRow> = {}): ConflictRow {
  return {
    id: "cf_1",
    memory_a: "mem_a",
    memory_b: "mem_b",
    pair_lo: "mem_a",
    pair_hi: "mem_b",
    kind: "value-conflict",
    fact_key: "deadline",
    value_hash: "sha256:vh_1",
    entity: "nova",
    detail: 'deadline: "2026-08-15" vs "2026-09-01"',
    created_at: "2026-07-01T00:00:01.000Z",
    state: "open",
    resolved_at: null,
    ...overrides,
  };
}

/** Seed a single open, both-sides-live conflict directly via the journal
 * (Journal.insertMemory + insertConflict), mirroring core's own
 * conflicts/contradiction test fixtures — no need to route through the real
 * detector for a bridge-surfacing test. */
function seedConflict(ctx: Awaited<ReturnType<typeof openTestVault>>): void {
  ctx.journal.insertMemory(memRow({ id: "mem_a", path: "mem_a.md", status: "canonical" }));
  ctx.journal.insertMemory(memRow({ id: "mem_b", path: "mem_b.md", status: "scratch" }));
  ctx.journal.insertConflict(conflictRow());
}

describe("GET/POST /conflicts", () => {
  test("GET /conflicts returns 1 enriched item (row + memoryA + memoryB)", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();
    seedConflict(ctx);

    app = buildBridge(ctx, TOKEN);
    const res = await app.inject({ method: "GET", url: "/conflicts", headers: HEADERS });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ row: ConflictRow; memoryA: MemoryRow; memoryB: MemoryRow }>;
    expect(body).toHaveLength(1);
    expect(body[0]!.row.id).toBe("cf_1");
    expect(body[0]!.memoryA.id).toBe("mem_a");
    expect(body[0]!.memoryB.id).toBe("mem_b");
  });

  test("POST /conflicts/:id/resolve drops it from the open list", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();
    seedConflict(ctx);

    app = buildBridge(ctx, TOKEN);
    const resolveRes = await app.inject({
      method: "POST",
      url: "/conflicts/cf_1/resolve",
      headers: JSON_HEADERS,
    });
    expect(resolveRes.statusCode).toBe(200);
    expect(resolveRes.json()).toMatchObject({ resolved: true });

    const listRes = await app.inject({ method: "GET", url: "/conflicts", headers: HEADERS });
    expect(listRes.json()).toHaveLength(0);
  });

  test("POST /conflicts/:id/dismiss drops it from the open list", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();
    seedConflict(ctx);

    app = buildBridge(ctx, TOKEN);
    const dismissRes = await app.inject({
      method: "POST",
      url: "/conflicts/cf_1/dismiss",
      headers: JSON_HEADERS,
    });
    expect(dismissRes.statusCode).toBe(200);
    expect(dismissRes.json()).toMatchObject({ dismissed: true });

    const listRes = await app.inject({ method: "GET", url: "/conflicts", headers: HEADERS });
    expect(listRes.json()).toHaveLength(0);
  });

  test("a conflict whose one memory is forgotten never appears", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();
    ctx.journal.insertMemory(memRow({ id: "mem_a", path: "mem_a.md", status: "canonical" }));
    ctx.journal.insertMemory(memRow({ id: "mem_b", path: "mem_b.md", status: "forgotten" }));
    ctx.journal.insertConflict(conflictRow());

    app = buildBridge(ctx, TOKEN);
    const res = await app.inject({ method: "GET", url: "/conflicts", headers: HEADERS });
    expect(res.json()).toHaveLength(0);
  });

  test("unknown id: resolve returns 404 with a typed error body", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();

    app = buildBridge(ctx, TOKEN);
    const res = await app.inject({
      method: "POST",
      url: "/conflicts/cf_does_not_exist/resolve",
      headers: JSON_HEADERS,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  test("unknown id: dismiss returns 404 with a typed error body", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();

    app = buildBridge(ctx, TOKEN);
    const res = await app.inject({
      method: "POST",
      url: "/conflicts/cf_does_not_exist/dismiss",
      headers: JSON_HEADERS,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  test("POST /conflicts/:id/resolve on an already-dismissed conflict returns 409, and the state is NOT flipped back", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();
    seedConflict(ctx);

    app = buildBridge(ctx, TOKEN);
    const dismissRes = await app.inject({
      method: "POST",
      url: "/conflicts/cf_1/dismiss",
      headers: JSON_HEADERS,
    });
    expect(dismissRes.statusCode).toBe(200);

    const resolveRes = await app.inject({
      method: "POST",
      url: "/conflicts/cf_1/resolve",
      headers: JSON_HEADERS,
    });
    expect(resolveRes.statusCode).toBe(409);
    expect(resolveRes.json()).toMatchObject({ error: { code: "ALREADY_CLOSED" } });

    // The stored state must still be 'dismissed', not overwritten to 'resolved'.
    expect(ctx.journal.getConflict("cf_1")!.state).toBe("dismissed");
  });

  test("POST /conflicts/:id/dismiss on an already-resolved conflict returns 409", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();
    seedConflict(ctx);

    app = buildBridge(ctx, TOKEN);
    const resolveRes = await app.inject({
      method: "POST",
      url: "/conflicts/cf_1/resolve",
      headers: JSON_HEADERS,
    });
    expect(resolveRes.statusCode).toBe(200);

    const dismissRes = await app.inject({
      method: "POST",
      url: "/conflicts/cf_1/dismiss",
      headers: JSON_HEADERS,
    });
    expect(dismissRes.statusCode).toBe(409);
    expect(dismissRes.json()).toMatchObject({ error: { code: "ALREADY_CLOSED" } });

    expect(ctx.journal.getConflict("cf_1")!.state).toBe("resolved");
  });

  test("POST /conflicts/:id/resolve on a genuinely open conflict still succeeds (happy path unchanged)", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();
    seedConflict(ctx);

    app = buildBridge(ctx, TOKEN);
    const resolveRes = await app.inject({
      method: "POST",
      url: "/conflicts/cf_1/resolve",
      headers: JSON_HEADERS,
    });
    expect(resolveRes.statusCode).toBe(200);
    expect(resolveRes.json()).toMatchObject({ resolved: true });
  });

  test("GET /conflicts with no auth returns 401", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();
    seedConflict(ctx);

    app = buildBridge(ctx, TOKEN);
    const res = await app.inject({ method: "GET", url: "/conflicts", headers: { host: "127.0.0.1:51789" } });
    expect(res.statusCode).toBe(401);
  });
});
