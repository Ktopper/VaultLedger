import { describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildBridge } from "../src/app.js";

/** Task 2.1 doesn't need a real vault — buildBridge only needs a ctx-shaped
 * object whose fields the auth/loopback preHandler doesn't touch. We stub
 * the minimum surface; later tasks (2.2+) will build real VaultContext
 * fixtures once routes actually read from it. */
function fakeCtx(): Parameters<typeof buildBridge>[0] {
  return {} as Parameters<typeof buildBridge>[0];
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
    expect(res.json()).toMatchObject({ ok: true });
    await app.close();
  });
});
