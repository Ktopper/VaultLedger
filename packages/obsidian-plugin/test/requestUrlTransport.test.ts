import { describe, expect, test } from "vitest";
import { makeRequestUrlTransport } from "../src/requestUrlTransport.js";

/**
 * Shape a fake `RequestUrlResponse` per the pinned obsidian@1.13.1 .d.ts:
 * `json`/`text` are PROPERTIES (not methods), and `arrayBuffer` is present.
 */
function fakeResp(
  over: Partial<{ status: number; text: string; json: unknown; headers: Record<string, string> }>,
) {
  return { status: 200, headers: {}, text: "", json: null, arrayBuffer: new ArrayBuffer(0), ...over };
}

describe("requestUrlTransport", () => {
  test("maps a 200 body through res.json()", async () => {
    const t = makeRequestUrlTransport(
      (() =>
        Promise.resolve(
          fakeResp({ text: JSON.stringify({ hello: "world" }), json: { hello: "world" } }),
        )) as never,
    );
    const res = await t("http://x/status", { method: "GET" });
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ hello: "world" });
  });

  test("throw:false → a 4xx STATUS returns a non-ok Response, not a throw", async () => {
    const t = makeRequestUrlTransport(
      (() => Promise.resolve(fakeResp({ status: 401, text: '{"error":{"code":"AUTH"}}' }))) as never,
    );
    const res = await t("http://x/status", {});
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
  });

  test("FOLD 2 — a connection-level rejection THROWS THROUGH (arms reconnect), not swallowed", async () => {
    const t = makeRequestUrlTransport((() => Promise.reject(new Error("ECONNREFUSED"))) as never);
    await expect(t("http://x/status", {})).rejects.toThrow(/ECONNREFUSED/);
  });

  test("FOLD 3 — a 204 null-body status does NOT throw constructing the Response", async () => {
    const t = makeRequestUrlTransport(
      (() => Promise.resolve(fakeResp({ status: 204, text: "" }))) as never,
    );
    const res = await t("http://x/x", {});
    expect(res.status).toBe(204);
  });

  test("honors AbortSignal.timeout by rejecting", async () => {
    const t = makeRequestUrlTransport(((() => new Promise(() => {})) as never)); // never resolves
    await expect(t("http://x/x", { signal: AbortSignal.timeout(10) })).rejects.toThrow();
  });
});
