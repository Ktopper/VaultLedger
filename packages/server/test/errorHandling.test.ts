import { afterEach, describe, expect, test, vi } from "vitest";
import type { FastifyInstance } from "fastify";
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
  vi.restoreAllMocks();
});

describe("error handler honesty", () => {
  // #2: a malformed JSON body on an AUTHENTICATED, loopback POST is a client
  // error (Fastify sets err.statusCode = 400). The handler must honor that
  // rather than forcing every non-BrokerError to 500.
  test("malformed JSON body on an authenticated POST -> 400, not 500", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();

    app = buildBridge(ctx, TOKEN);
    const res = await app.inject({
      method: "POST",
      url: "/undo",
      headers: JSON_HEADERS,
      payload: "{not valid json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.statusCode).not.toBe(500);
  });

  // #3: a genuine internal error (a non-BrokerError thrown inside a handler)
  // must NOT echo the underlying message (it can carry fs paths / library
  // internals), and must be logged server-side.
  test("a forced internal error -> generic message (no detail leak) and is logged", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();

    const SECRET = "SECRET-detail /Users/someone/.ssh/id_rsa";
    // Make a read route throw a plain (non-Broker) Error carrying a secret.
    ctx.approvals.list = () => {
      throw new Error(SECRET);
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    app = buildBridge(ctx, TOKEN);
    const res = await app.inject({ method: "GET", url: "/status", headers: HEADERS });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body).toMatchObject({ error: { code: "INTERNAL" } });
    // The generic message must NOT contain the underlying secret detail.
    expect(body.error.message).toBe("internal error");
    expect(JSON.stringify(body)).not.toContain("SECRET-detail");
    expect(JSON.stringify(body)).not.toContain("id_rsa");
    // Something WAS logged server-side.
    expect(errorSpy).toHaveBeenCalled();
  });
});
