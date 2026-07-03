import { describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildBridge, isLoopbackHost } from "../src/app.js";

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

  // SECURITY (#1): the loopback + auth guard MUST run before Fastify parses
  // the request body — otherwise a malformed JSON body reaches the JSON
  // parser (which errors) and the request is rejected by the error handler
  // WITHOUT ever passing the guard, i.e. an unauthenticated, non-loopback
  // caller can trip the parser. The guard lives in an `onRequest` hook (runs
  // before preParsing/parsing), so an evil-Host + no-auth + malformed-body
  // POST must be rejected by the guard (403 loopback or 401 auth), never a
  // 500 (parser) or 400 (parse error).
  test("guard fires before body parsing: evil Host + no auth + malformed JSON body -> 403/401, never 500", async () => {
    const app: FastifyInstance = buildBridge(fakeCtx(), TOKEN);
    const res = await app.inject({
      method: "POST",
      url: "/undo",
      headers: { host: "evil.com", "content-type": "application/json" },
      payload: "{not json",
    });
    expect([401, 403]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(500);
    await app.close();
  });
});

describe("isLoopbackHost (pure)", () => {
  test("undefined -> false", () => {
    expect(isLoopbackHost(undefined)).toBe(false);
  });

  test("empty string -> false", () => {
    expect(isLoopbackHost("")).toBe(false);
  });

  test.each([
    ["127.0.0.1", true],
    ["127.0.0.1:51789", true],
    ["localhost", true],
    ["localhost:3000", true],
    ["[::1]", true],
    ["[::1]:8080", true],
    // A bare, unbracketed IPv6 literal is not a valid HTTP Host header (RFC
    // 7230 requires brackets: `[::1]`); the parser splits on the first colon
    // and can't recover one, so it's (safely) rejected as non-loopback.
    ["::1", false],
    ["evil.com", false],
    ["evil.com:80", false],
    // A rebinding attempt that embeds the loopback IP as a label of a public
    // hostname must NOT be treated as loopback.
    ["127.0.0.1.evil.com", false],
    ["127.0.0.1.evil.com:443", false],
  ])("%s -> %s", (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});
