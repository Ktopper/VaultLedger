import { describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildBridge } from "../src/app.js";

/** Task 2.1's auth/loopback preHandler doesn't touch the vault context at
 * all — it short-circuits before any route handler runs. The one exception
 * is the "success" case, which does fall through to the real /status
 * handler (fleshed out in Task 2.2), so this stub supplies just enough
 * VaultContext shape for that handler not to crash; the read-route tests in
 * read.test.ts are what actually exercise /status against a real vault. */
function fakeCtx(): Parameters<typeof buildBridge>[0] {
  return {
    manifest: { zones: { trusted: [], agent: [], scratch: [], excluded: [] }, mode: "assisted" },
    approvals: { list: () => [] },
    journal: { listTransactions: () => [] },
  } as unknown as Parameters<typeof buildBridge>[0];
}

const TOKEN = "test-token-123";

describe("buildBridge auth + loopback guard", () => {
  test("missing Authorization header -> 401", async () => {
    const app: FastifyInstance = buildBridge(fakeCtx(), TOKEN);
    const res = await app.inject({ method: "GET", url: "/status", headers: { host: "127.0.0.1:51789" } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    await app.close();
  });

  test("wrong token -> 401", async () => {
    const app: FastifyInstance = buildBridge(fakeCtx(), TOKEN);
    const res = await app.inject({
      method: "GET",
      url: "/status",
      headers: { host: "127.0.0.1:51789", authorization: "Bearer wrong-token" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    await app.close();
  });

  test("correct token but non-loopback Host -> 403", async () => {
    const app: FastifyInstance = buildBridge(fakeCtx(), TOKEN);
    const res = await app.inject({
      method: "GET",
      url: "/status",
      headers: { host: "evil.com", authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "FORBIDDEN_ORIGIN" } });
    await app.close();
  });

  test("correct token + loopback Host -> 200 on /status", async () => {
    const app: FastifyInstance = buildBridge(fakeCtx(), TOKEN);
    const res = await app.inject({
      method: "GET",
      url: "/status",
      headers: { host: "127.0.0.1:51789", authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
