import { afterEach, describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createPatch } from "diff";
import { loadServerContext, type ServerContext } from "../src/context.js";
import { buildTools, type ToolDef } from "../src/tools.js";
import { listToolNames, parseVaultArg } from "../src/index.js";
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

describe("buildTools", () => {
  test("registers exactly the 7 spec tools", async () => {
    const { tools } = await setup();
    expect([...tools.keys()].sort()).toEqual(
      [
        "ledger_status",
        "memory_forget",
        "memory_promote",
        "memory_recall",
        "memory_remember",
        "memory_revise",
        "vault_propose_edit",
      ].sort(),
    );
  });

  test("listToolNames() stays in sync with the names buildTools registers", async () => {
    const { tools } = await setup();
    expect(listToolNames().sort()).toEqual([...tools.keys()].sort());
  });

  test("memory_remember creates a memory with provenance, and the note lands on disk", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;

    const result = await remember.handler({
      content: "Alice prefers dark mode.",
      entity: "alice",
      reason: "user stated a preference",
      tags: ["preference"],
    });

    expect(result.error).toBeUndefined();
    expect(typeof result.id).toBe("string");
    expect(typeof result.path).toBe("string");
    expect(result.status).toBe("scratch");
    expect(result.provenance).toBeTruthy();
    const provenance = result.provenance as Record<string, unknown>;
    expect(provenance.source).toBe("mcp-test-session");
    expect(provenance.status).toBe("scratch");

    const abs = join(vault.vaultDir, result.path as string);
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, "utf8")).toContain("Alice prefers dark mode.");

    // recall finds it back
    const recall = tools.get("memory_recall")!;
    const recalled = await recall.handler({ entity: "alice" });
    expect(recalled.error).toBeUndefined();
    const memories = recalled.memories as Array<Record<string, unknown>>;
    expect(memories.some((m) => m.id === result.id)).toBe(true);
  });

  test("memory_recall filters by entity", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;
    await remember.handler({ content: "note about bob", entity: "bob", reason: "seed" });
    await remember.handler({ content: "note about alice", entity: "alice", reason: "seed" });

    const recall = tools.get("memory_recall")!;
    const result = await recall.handler({ entity: "bob" });

    expect(result.error).toBeUndefined();
    const memories = result.memories as Array<Record<string, unknown>>;
    expect(memories).toHaveLength(1);
    expect(memories[0]?.entity).toBe("bob");
  });

  test("memory_revise happy path patches the note", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;
    const created = await remember.handler({ content: "line one", reason: "seed" });
    const abs = join(vault.vaultDir, created.path as string);
    const before = readFileSync(abs, "utf8");
    const after = before + "\nline two";
    const patch = createPatch(created.path as string, before, after);

    const revise = tools.get("memory_revise")!;
    const result = await revise.handler({ id: created.id, patch, reason: "append line two" });

    expect(result.error).toBeUndefined();
    expect(result.id).toBe(created.id);
    expect(result.revised).toBe(true);
    expect(readFileSync(abs, "utf8")).toContain("line two");
  });

  test("memory_revise with an unparseable patch returns a structured BrokerError, not a throw", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;
    const created = await remember.handler({ content: "line one", reason: "seed" });

    const revise = tools.get("memory_revise")!;
    const result = await revise.handler({
      id: created.id,
      patch: "this is not a unified diff",
      reason: "bogus",
    });

    expect(result.revised).toBeUndefined();
    expect(result.error).toBeTruthy();
    const error = result.error as { code: string; retriable: boolean };
    expect(error.code).toBe("SYNTAX_BREAK");
    expect(error.retriable).toBe(false);
  });

  test("vault_propose_edit on a trusted note queues an approval", async () => {
    const { tools } = await setup();
    const abs = join(vault.vaultDir, "Notes", "trusted.md");
    const before = readFileSync(abs, "utf8");
    const after = before + "\nan appended line\n";
    const patch = createPatch("Notes/trusted.md", before, after);

    const propose = tools.get("vault_propose_edit")!;
    const result = await propose.handler({
      path: "Notes/trusted.md",
      patch,
      reason: "propose an update",
      expected_hash: "irrelevant-for-propose_edit-queueing",
    });

    expect(result.error).toBeUndefined();
    expect(result.queued).toBe(true);
    expect(typeof result.approvalId).toBe("string");
  });

  test("vault_propose_edit on an excluded path returns a structured FORBIDDEN_ZONE error", async () => {
    const { tools } = await setup();
    const propose = tools.get("vault_propose_edit")!;

    const result = await propose.handler({
      path: "Private/secret.md",
      patch: "irrelevant",
      reason: "try to sneak an edit in",
      expected_hash: "irrelevant",
    });

    expect(result.queued).toBeUndefined();
    expect(result.error).toBeTruthy();
    const error = result.error as { code: string; retriable: boolean };
    expect(error.code).toBe("FORBIDDEN_ZONE");
    expect(error.retriable).toBe(false);
  });

  test("memory_promote working->canonical returns an approvalId, surfaced by ledger_status", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;
    const created = await remember.handler({ content: "promote me", reason: "seed" });

    const promote = tools.get("memory_promote")!;
    const toWorking = await promote.handler({
      id: created.id,
      target_status: "working",
      reason: "referenced enough",
    });
    expect(toWorking.error).toBeUndefined();
    expect(toWorking.promoted).toBe(true);

    const toCanonical = await promote.handler({
      id: created.id,
      target_status: "canonical",
      reason: "ready for canonical",
    });
    expect(toCanonical.error).toBeUndefined();
    expect(toCanonical.promoted).toBe(false);
    expect(typeof toCanonical.approvalId).toBe("string");

    const status = tools.get("ledger_status")!;
    const statusResult = await status.handler({});
    const pending = statusResult.pendingApprovals as Array<Record<string, unknown>>;
    expect(pending.some((a) => a.id === toCanonical.approvalId)).toBe(true);
  });

  test("memory_forget tombstones a memory", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;
    const created = await remember.handler({ content: "forget me", reason: "seed" });

    const forget = tools.get("memory_forget")!;
    const result = await forget.handler({ id: created.id, reason: "no longer needed" });

    expect(result.error).toBeUndefined();
    expect(result.id).toBe(created.id);
    expect(result.forgotten).toBe(true);
  });

  test("memory_remember with a missing reason returns a structured validation error, not a throw", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;

    const result = await remember.handler({ content: "no reason given" });

    expect(result.id).toBeUndefined();
    expect(result.error).toBeTruthy();
    const error = result.error as { code: string };
    expect(error.code).toBe("INVALID_ARGS");
  });

  test("memory_recall rejects the now-removed `query` param (spec §9 filter set only)", async () => {
    const { tools } = await setup();
    const recall = tools.get("memory_recall")!;

    const result = await recall.handler({ query: "free text" });

    expect(result.memories).toBeUndefined();
    expect(result.error).toBeTruthy();
    const error = result.error as { code: string };
    expect(error.code).toBe("INVALID_ARGS");
  });
});

describe("parseVaultArg", () => {
  test("throws a clear diagnostic when --vault is missing", () => {
    expect(() => parseVaultArg([])).toThrow(/--vault <path> is required/);
    expect(() => parseVaultArg(["--other", "x"])).toThrow(/--vault <path> is required/);
  });

  test("resolves a relative --vault to an absolute path", () => {
    const result = parseVaultArg(["--vault", "some/rel/vault"]);
    expect(isAbsolute(result)).toBe(true);
    expect(result).toBe(resolve("some/rel/vault"));
  });

  test("leaves an already-absolute --vault unchanged", () => {
    const abs = resolve("/tmp/vault");
    expect(parseVaultArg(["--vault", abs])).toBe(abs);
  });
});
