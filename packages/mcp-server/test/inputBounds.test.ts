import { afterEach, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPatch } from "diff";
import { loadServerContext, type ServerContext } from "../src/context.js";
import { buildTools, type ToolDef } from "../src/tools.js";
import { makeTestVault, type TestVault } from "./helpers.js";

let vault: TestVault;
let ctx: ServerContext;

afterEach(() => {
  ctx?.db.close();
  vault?.cleanup();
});

function makeClock(): { now: () => string; genId: (prefix: string) => string } {
  let tick = 0;
  let counter = 0;
  return {
    now: () => {
      tick += 1;
      return new Date(2026, 0, 1, 0, 0, tick).toISOString();
    },
    genId: (prefix: string) => {
      counter += 1;
      return `${prefix}_${counter}`;
    },
  };
}

async function setup(): Promise<{ tools: Map<string, ToolDef> }> {
  vault = await makeTestVault();
  const { now, genId } = makeClock();
  ctx = await loadServerContext(vault.vaultDir, { ...vault.deps, now, genId, session: "mcp-test-session" });
  const tools = new Map(buildTools(ctx).map((t) => [t.name, t]));
  return { tools };
}

function invalidArgsCode(result: Record<string, unknown>): string | undefined {
  return (result.error as { code?: string } | undefined)?.code;
}

/**
 * VL-SEC-S4-05: before this fix, `content`/`patch`/`sources`/`tags`/`reason`
 * (and other free-text/array MCP inputs) were bare `z.string()`/`z.array()`
 * with no `.max()` anywhere. A giant `content`/`patch` permanently bloats
 * vault git history (every mutation is committed); a `sources`/`tags` array
 * with millions of entries blocks the synchronous SQLite journal writer; a
 * pathological `vault_propose_edit` patch defers a crash to approval time.
 * These tests prove the zod layer now rejects over-limit inputs BEFORE any
 * of that work happens, and that ordinary-size inputs are unaffected.
 */
describe("MCP tool input bounds (VL-SEC-S4-05)", () => {
  test("memory_remember rejects content over the size cap", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;

    const result = await remember.handler({
      content: "x".repeat(16 * 1024 + 1),
      reason: "seed",
    });

    expect(result.id).toBeUndefined();
    expect(invalidArgsCode(result)).toBe("INVALID_ARGS");
  });

  test("memory_remember accepts content right at the size cap", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;

    const result = await remember.handler({
      content: "x".repeat(16 * 1024),
      reason: "seed",
    });

    expect(result.error).toBeUndefined();
    expect(typeof result.id).toBe("string");
  });

  test("memory_remember rejects multi-byte content whose UTF-16 length is under the cap but UTF-8 byte length is over", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;

    // "中" is 1 UTF-16 code unit (JS .length) but 3 UTF-8 bytes. 8193 of them
    // is 8193 chars (well under a 16384 CHAR cap) yet 24579 bytes (over the
    // 16 KiB BYTE cap) -- a char-count `.max()` would wrongly ACCEPT this and
    // commit ~24 KiB to git; the byte-count refine must REJECT it.
    const content = "中".repeat(8_193);
    expect(content.length).toBeLessThan(16 * 1024); // under a char cap
    expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(16 * 1024); // over the byte cap

    const result = await remember.handler({ content, reason: "seed" });

    expect(result.id).toBeUndefined();
    expect(invalidArgsCode(result)).toBe("INVALID_ARGS");
  });

  test("memory_remember accepts multi-byte content whose UTF-8 byte length is within the cap", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;

    // 5000 "中" = 15000 bytes, comfortably within the 16 KiB byte cap.
    const content = "中".repeat(5_000);
    expect(Buffer.byteLength(content, "utf8")).toBeLessThan(16 * 1024);

    const result = await remember.handler({ content, reason: "seed" });

    expect(result.error).toBeUndefined();
    expect(typeof result.id).toBe("string");
  });

  test("memory_remember rejects an oversized reason", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;

    const result = await remember.handler({
      content: "normal content",
      reason: "x".repeat(2_001),
    });

    expect(result.id).toBeUndefined();
    expect(invalidArgsCode(result)).toBe("INVALID_ARGS");
  });

  test("memory_remember rejects a tags array with more than the element-count cap", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;

    const result = await remember.handler({
      content: "normal content",
      reason: "seed",
      tags: Array.from({ length: 101 }, (_, i) => `tag${i}`),
    });

    expect(result.id).toBeUndefined();
    expect(invalidArgsCode(result)).toBe("INVALID_ARGS");
  });

  test("memory_remember accepts a tags array right at the element-count cap", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;

    const result = await remember.handler({
      content: "normal content",
      reason: "seed",
      tags: Array.from({ length: 100 }, (_, i) => `tag${i}`),
    });

    expect(result.error).toBeUndefined();
    expect(typeof result.id).toBe("string");
  });

  test("memory_remember rejects an over-length individual tag", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;

    const result = await remember.handler({
      content: "normal content",
      reason: "seed",
      tags: ["x".repeat(129)],
    });

    expect(result.id).toBeUndefined();
    expect(invalidArgsCode(result)).toBe("INVALID_ARGS");
  });

  test("memory_distill rejects a sources array with more than the element-count cap (zod, not INVALID_SOURCE)", async () => {
    const { tools } = await setup();
    const distill = tools.get("memory_distill")!;

    const result = await distill.handler({
      content: "a distillation",
      sources: Array.from({ length: 101 }, (_, i) => `mem_${i}`),
      reason: "summarize",
    });

    expect(result.id).toBeUndefined();
    // This must be caught at the zod layer (INVALID_ARGS), not fall through
    // to the store's per-source existence check (INVALID_SOURCE) -- the
    // whole point is bounding the array BEFORE the store does 101 lookups.
    expect(invalidArgsCode(result)).toBe("INVALID_ARGS");
  });

  test("memory_distill rejects an over-limit content field", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;
    const a = await remember.handler({ content: "source a", reason: "seed" });

    const distill = tools.get("memory_distill")!;
    const result = await distill.handler({
      content: "x".repeat(16 * 1024 + 1),
      sources: [a.id],
      reason: "summarize",
    });

    expect(result.id).toBeUndefined();
    expect(invalidArgsCode(result)).toBe("INVALID_ARGS");
  });

  test("memory_revise rejects an over-limit patch", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;
    const created = await remember.handler({ content: "original content", reason: "seed" });

    const revise = tools.get("memory_revise")!;
    const result = await revise.handler({
      id: created.id,
      patch: "x".repeat(16 * 1024 + 1),
      reason: "revise",
    });

    expect(result.revised).toBeUndefined();
    expect(invalidArgsCode(result)).toBe("INVALID_ARGS");
  });

  test("vault_propose_edit rejects an over-limit patch", async () => {
    const { tools } = await setup();
    const propose = tools.get("vault_propose_edit")!;

    const result = await propose.handler({
      path: "Notes/trusted.md",
      patch: "x".repeat(16 * 1024 + 1),
      reason: "propose",
      expected_hash: "deadbeef",
    });

    expect(result.queued).toBeUndefined();
    expect(invalidArgsCode(result)).toBe("INVALID_ARGS");
  });

  test("memory_remember rejects an over-limit entity", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;

    const result = await remember.handler({
      content: "normal content",
      reason: "seed",
      entity: "x".repeat(257),
    });

    expect(result.id).toBeUndefined();
    expect(invalidArgsCode(result)).toBe("INVALID_ARGS");
  });

  test("normal-size memory_remember + memory_revise round trip is unaffected by the new bounds", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;
    const created = await remember.handler({
      content: "A perfectly ordinary memory.",
      entity: "alice",
      reason: "user stated a preference",
      tags: ["preference", "ui"],
    });
    expect(created.error).toBeUndefined();

    const revise = tools.get("memory_revise")!;
    const before = readFileSync(join(vault.vaultDir, created.path as string), "utf8");
    const after = before.replace(
      "A perfectly ordinary memory.",
      "A perfectly ordinary memory, revised.",
    );
    const patch = createPatch("note.md", before, after);
    const result = await revise.handler({ id: created.id, patch, reason: "small fix" });
    expect(result.error).toBeUndefined();
  });
});
