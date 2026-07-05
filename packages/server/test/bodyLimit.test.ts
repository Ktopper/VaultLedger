import { afterEach, describe, expect, test } from "vitest";
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
});

describe("app-level bodyLimit", () => {
  // Covers ALL routes (incl. any future /conflicts mutation routes), not
  // just /undo — set once on the Fastify instance itself.
  test("POST /undo with a body over 16 KiB -> 413, clean JSON (not a hang/500)", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();

    app = buildBridge(ctx, TOKEN);

    const oversized = "x".repeat(17 * 1024); // > 16 KiB
    const res = await app.inject({
      method: "POST",
      url: "/undo",
      headers: JSON_HEADERS,
      payload: oversized,
    });

    expect(res.statusCode).toBe(413);
    expect(res.statusCode).not.toBe(500);
    // Clean, typed JSON error body — not a raw stack trace / plain-text dump.
    const body = res.json();
    expect(body).toHaveProperty("error");
    expect(typeof body.error.code).toBe("string");
    expect(typeof body.error.message).toBe("string");
  });

  test("a normal small body on POST /undo still routes normally (unknown txn -> 404)", async () => {
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
});
