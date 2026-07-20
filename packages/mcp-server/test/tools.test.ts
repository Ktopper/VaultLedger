import { afterEach, describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createPatch } from "diff";
import { hashBytes, hashFile } from "@vault-ledger/core";
import { loadServerContext, type ServerContext } from "../src/context.js";
import { buildTools, type ToolDef } from "../src/tools.js";
import { listToolNames, parseNoSweep, parseVaultArg } from "../src/index.js";
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

async function setup(opts?: { allowRawDiff?: boolean }): Promise<{ tools: Map<string, ToolDef> }> {
  vault = await makeTestVault();
  const { now, genId } = makeClock();
  ctx = await loadServerContext(vault.vaultDir, {
    ...vault.deps,
    now,
    genId,
    session: "mcp-test-session",
    allowRawDiff: opts?.allowRawDiff,
  });
  const tools = new Map(buildTools(ctx).map((t) => [t.name, t]));
  return { tools };
}

describe("buildTools", () => {
  test("registers exactly the 15 default v1 tools (vault_propose_edit NOT among them)", async () => {
    const { tools } = await setup();
    expect([...tools.keys()].sort()).toEqual(
      [
        "ledger_status",
        "memory_distill",
        "memory_forget",
        "memory_promote",
        "memory_recall",
        "memory_remember",
        "memory_retire",
        "memory_revise",
        "vault_read",
        "vault_list",
        "vault_search",
        "vault_propose_replace",
        "vault_propose_create",
        "vault_propose_delete",
        "vault_propose_move",
      ].sort(),
    );
    expect(tools.has("vault_propose_edit")).toBe(false);
  });

  test("with --allow-raw-diff, buildTools registers the 16th tool vault_propose_edit", async () => {
    const { tools } = await setup({ allowRawDiff: true });
    expect(tools.size).toBe(16);
    expect(tools.has("vault_propose_edit")).toBe(true);
    expect([...tools.keys()].sort()).toEqual(listToolNames(true).sort());
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

  test("memory_remember accepts and forwards an optional supersedes id (wired through to the memory row + file frontmatter)", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;

    const a = await remember.handler({
      content: "deadline: 2026-08-15",
      entity: "nova",
      reason: "seed",
    });
    expect(a.error).toBeUndefined();

    const b = await remember.handler({
      content: "deadline: 2026-09-01",
      entity: "nova",
      reason: "updated belief",
      supersedes: a.id,
    });

    expect(b.error).toBeUndefined();
    const provenance = b.provenance as Record<string, unknown>;
    expect(provenance.supersedes).toBe(a.id);

    const abs = join(vault.vaultDir, b.path as string);
    expect(readFileSync(abs, "utf8")).toContain(`supersedes: ${a.id as string}`);
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

  test("memory_revise on a CANONICAL memory returns a queued approvalId instead of applying, on a WORKING memory it applies (audit: no agent-reachable path revises a canonical without approval)", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;
    const revise = tools.get("memory_revise")!;

    // CANONICAL: memory_revise (the only agent-reachable content-edit tool)
    // must queue, not apply.
    const canonical = await remember.handler({ content: "canonical fact", reason: "seed" });
    await ctx.store.setStatus(canonical.id, "canonical", "approved as durable belief", "s1");
    const abs = join(vault.vaultDir, canonical.path as string);
    const before = readFileSync(abs, "utf8");
    const after = before.replace("canonical fact", "canonical fact, revised");
    const patch = createPatch(canonical.path as string, before, after);

    const queuedResult = await revise.handler({ id: canonical.id, patch, reason: "tighten wording" });

    expect(queuedResult.error).toBeUndefined();
    expect(queuedResult.queued).toBe(true);
    expect(typeof queuedResult.approvalId).toBe("string");
    expect(queuedResult.revised).toBeUndefined();
    expect(readFileSync(abs, "utf8")).toBe(before);
    expect(ctx.journal.getMemory(canonical.id as string)!.status).toBe("canonical");

    // WORKING: applies immediately, same as before the gate.
    const working = await remember.handler({ content: "working fact", reason: "seed" });
    const promote = tools.get("memory_promote")!;
    await promote.handler({ id: working.id, target_status: "working", reason: "confirmed" });
    const workingAbs = join(vault.vaultDir, working.path as string);
    const workingBefore = readFileSync(workingAbs, "utf8");
    const workingAfter = workingBefore + "\nan appended line";
    const workingPatch = createPatch(working.path as string, workingBefore, workingAfter);

    const appliedResult = await revise.handler({ id: working.id, patch: workingPatch, reason: "append" });

    expect(appliedResult.error).toBeUndefined();
    expect(appliedResult.revised).toBe(true);
    expect(appliedResult.queued).toBeUndefined();
    expect(readFileSync(workingAbs, "utf8")).toBe(workingAfter);
  });

  test("vault_propose_edit on a trusted note queues an approval", async () => {
    // WU-5: vault_propose_edit is off the default surface — exercise it through
    // a flag-on ctx (--allow-raw-diff).
    const { tools } = await setup({ allowRawDiff: true });
    const abs = join(vault.vaultDir, "Notes", "trusted.md");
    const before = readFileSync(abs, "utf8");
    const after = before + "\nan appended line\n";
    const patch = createPatch("Notes/trusted.md", before, after);

    const propose = tools.get("vault_propose_edit")!;
    const result = await propose.handler({
      path: "Notes/trusted.md",
      patch,
      reason: "propose an update",
      // Must be well-formed (sha256:<64 hex>) since the broker now validates
      // expected_hash format at enqueue time (MALFORMED_HASH); its value is
      // otherwise irrelevant here since propose_edit only queues -- the
      // held hash is only compared for staleness later, at approve-time.
      expected_hash: `sha256:${"0".repeat(64)}`,
    });

    expect(result.error).toBeUndefined();
    expect(result.queued).toBe(true);
    expect(typeof result.approvalId).toBe("string");
  });

  test("vault_propose_edit on an excluded path returns a structured FORBIDDEN_ZONE error", async () => {
    const { tools } = await setup({ allowRawDiff: true });
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

  test("vault_propose_replace is registered and queues via the broker", async () => {
    const { tools } = await setup();
    const path = "Notes/trusted.md";
    // The note is seeded by makeTestVault; pin its live hash the same way an
    // agent would (from memory_recall / ledger_status).
    const expected_hash = hashFile(join(vault.vaultDir, path));

    const propose = tools.get("vault_propose_replace")!;
    const result = await propose.handler({
      path,
      expected_hash,
      replacements: [{ old_text: "Some content.", new_text: "New content." }],
      reason: "fix the body via structured replace",
    });

    expect(result.error).toBeUndefined();
    expect(result.queued).toBe(true);
    expect(typeof result.approvalId).toBe("string");
  });

  test("vault_propose_replace: empty old_text reaches the broker as RETRIABLE (not INVALID_ARGS)", async () => {
    const { tools } = await setup();
    const path = "Notes/trusted.md";
    // Valid, matching hash so the handler gets PAST the hash gate and into the
    // pure generator, where empty old_text is rejected — proving the zod schema
    // does not floor old_text with .min(1) (which would surface INVALID_ARGS).
    const expected_hash = hashFile(join(vault.vaultDir, path));

    const propose = tools.get("vault_propose_replace")!;
    const result = await propose.handler({
      path,
      expected_hash,
      replacements: [{ old_text: "", new_text: "x" }],
      reason: "empty old_text",
    });

    expect(result.queued).toBeUndefined();
    expect(result.error).toBeTruthy();
    const error = result.error as { code: string; retriable: boolean };
    expect(error.retriable).toBe(true);
    expect(error.code).toBe("SYNTAX_BREAK");
    expect(error.code).not.toBe("INVALID_ARGS");
  });

  test("vault_propose_create is registered and queues a creation", async () => {
    const { tools } = await setup();
    const propose = tools.get("vault_propose_create")!;
    const result = await propose.handler({
      path: "Notes/created.md",
      content: "# New\n\nbody\n",
      reason: "create a new note from full content",
    });

    expect(result.error).toBeUndefined();
    expect(result.queued).toBe(true);
    expect(typeof result.approvalId).toBe("string");
  });

  test("vault_propose_delete queues a deletion and returns {queued, approvalId}", async () => {
    const { tools } = await setup();
    const expected_hash = hashFile(join(vault.vaultDir, "Notes", "trusted.md"));

    const del = tools.get("vault_propose_delete")!;
    const result = await del.handler({
      path: "Notes/trusted.md",
      expected_hash,
      reason: "remove the stale note",
    });

    expect(result.error).toBeUndefined();
    expect(result.queued).toBe(true);
    expect(typeof result.approvalId).toBe("string");
    // Queued only — the file is still on disk (nothing applied without approval).
    expect(existsSync(join(vault.vaultDir, "Notes", "trusted.md"))).toBe(true);
  });

  test("vault_propose_delete on an excluded path returns the SAME NOT_FOUND shape as a missing file (no zone vocabulary)", async () => {
    const { tools } = await setup();
    const del = tools.get("vault_propose_delete")!;

    const excluded = await del.handler({
      path: "Private/secret.md",
      expected_hash: `sha256:${"0".repeat(64)}`,
      reason: "attempt to delete an excluded note",
    });

    expect(excluded.queued).toBeUndefined();
    const error = excluded.error as { code: string; retriable: boolean; message: string };
    expect(error.code).toBe("NOT_FOUND");
    expect(error.retriable).toBe(true);
    expect(error.message).not.toMatch(/exclud|zone|forbidden/i);
  });

  test("vault_propose_move queues a move and returns {queued, approvalId}", async () => {
    const { tools } = await setup();
    const expected_hash = hashFile(join(vault.vaultDir, "Notes", "trusted.md"));

    const move = tools.get("vault_propose_move")!;
    const result = await move.handler({
      from: "Notes/trusted.md",
      to: "Notes/renamed.md",
      expected_hash,
      reason: "rename the note",
    });

    expect(result.error).toBeUndefined();
    expect(result.queued).toBe(true);
    expect(typeof result.approvalId).toBe("string");
    // Queued only — source unmoved until approval.
    expect(existsSync(join(vault.vaultDir, "Notes", "trusted.md"))).toBe(true);
    expect(existsSync(join(vault.vaultDir, "Notes", "renamed.md"))).toBe(false);
  });

  test("vault_propose_move to an excluded destination returns FORBIDDEN_ZONE (dest gate)", async () => {
    const { tools } = await setup();
    const expected_hash = hashFile(join(vault.vaultDir, "Notes", "trusted.md"));

    const move = tools.get("vault_propose_move")!;
    const result = await move.handler({
      from: "Notes/trusted.md",
      to: "Private/moved.md",
      expected_hash,
      reason: "try to move into an excluded zone",
    });

    expect(result.queued).toBeUndefined();
    const error = result.error as { code: string; retriable: boolean };
    expect(error.code).toBe("FORBIDDEN_ZONE");
  });

  test("vault_list returns directory entries and omits excluded entries (Private/.git/.ledger)", async () => {
    const { tools } = await setup();
    const list = tools.get("vault_list")!;

    const root = await list.handler({ path: "." });
    expect(root.error).toBeUndefined();
    expect(root.path).toBe(".");
    const rootNames = (root.entries as Array<{ name: string }>).map((e) => e.name);
    expect(rootNames).toContain("Notes");
    // Excluded entries are silently omitted — no marker, no zone vocabulary.
    expect(rootNames).not.toContain("Private");
    expect(rootNames).not.toContain(".git");
    expect(rootNames).not.toContain(".ledger");
    expect(JSON.stringify(root)).not.toMatch(/exclud|forbidden/i);

    const notes = await list.handler({ path: "Notes" });
    expect(notes.error).toBeUndefined();
    const notesEntries = notes.entries as Array<{ name: string; kind: string; size?: number }>;
    const trusted = notesEntries.find((e) => e.name === "trusted.md");
    expect(trusted).toBeDefined();
    expect(trusted!.kind).toBe("file");
    expect(typeof trusted!.size).toBe("number");
  });

  test("vault_list on a missing directory returns a structured NOT_FOUND, not a throw", async () => {
    const { tools } = await setup();
    const list = tools.get("vault_list")!;
    const result = await list.handler({ path: "Nope" });

    expect(result.entries).toBeUndefined();
    const error = result.error as { code: string; retriable: boolean };
    expect(error.code).toBe("NOT_FOUND");
    expect(error.retriable).toBe(true);
  });

  test("vault_search finds a literal match in a trusted note and never surfaces excluded content", async () => {
    const { tools } = await setup();
    const search = tools.get("vault_search")!;

    // "Trusted" appears only in Notes/trusted.md (a trusted note).
    const hit = await search.handler({ query: "trusted" });
    expect(hit.error).toBeUndefined();
    const matches = hit.matches as Array<{ path: string; snippet: string; line: number }>;
    expect(matches.some((m) => m.path === "Notes/trusted.md")).toBe(true);

    // "secret" appears ONLY in Private/secret.md (excluded) — it must be
    // skipped indistinguishably from a genuine no-match: empty, no signal.
    const excluded = await search.handler({ query: "secret" });
    expect(excluded.error).toBeUndefined();
    expect(excluded.matches).toEqual([]);
    expect(excluded.truncated).toBe(false);
    expect(JSON.stringify(excluded)).not.toMatch(/Private|exclud|skip/i);
  });

  test("vault_read returns {path, content, hash, size} with hash covering exactly content, on a seeded trusted note", async () => {
    const { tools } = await setup();
    const read = tools.get("vault_read")!;
    const result = await read.handler({ path: "Notes/trusted.md" });

    expect(result.error).toBeUndefined();
    expect(result.path).toBe("Notes/trusted.md");
    expect(result.content).toBe("# Trusted note\n\nSome content.\n");
    expect(result.hash).toBe(hashBytes(Buffer.from(result.content as string, "utf8")));
    expect(result.size).toBe(Buffer.byteLength(result.content as string, "utf8"));
    // The hash must be directly usable as expected_hash for a structured edit.
    expect(result.hash).toBe(hashFile(join(vault.vaultDir, "Notes", "trusted.md")));
  });

  test("vault_read on a missing path returns a structured NOT_FOUND (retriable) result, not a throw", async () => {
    const { tools } = await setup();
    const read = tools.get("vault_read")!;
    const result = await read.handler({ path: "Notes/ghost.md" });

    expect(result.content).toBeUndefined();
    expect(result.error).toBeTruthy();
    const error = result.error as { code: string; retriable: boolean; message: string };
    expect(error.code).toBe("NOT_FOUND");
    expect(error.retriable).toBe(true);
  });

  test("vault_read on an excluded path returns the SAME NOT_FOUND shape as a missing file (no zone vocabulary, VL-SEC-S7-04)", async () => {
    const { tools } = await setup();
    const read = tools.get("vault_read")!;
    // Private/secret.md EXISTS on disk (seeded by makeTestVault) but is excluded.
    const excluded = await read.handler({ path: "Private/secret.md" });
    const missing = await read.handler({ path: "Notes/ghost.md" });

    const exErr = excluded.error as { code: string; retriable: boolean; message: string };
    const missErr = missing.error as { code: string; retriable: boolean; message: string };
    expect(exErr.code).toBe("NOT_FOUND");
    expect(exErr.retriable).toBe(true);
    // Byte-identical rejection code+retriable to the genuinely-missing case.
    expect({ code: exErr.code, retriable: exErr.retriable }).toEqual({
      code: missErr.code,
      retriable: missErr.retriable,
    });
    // No zone vocabulary may leak — that would be the disclosure oracle.
    expect(exErr.message).not.toMatch(/exclud|zone|forbidden/i);
    expect(exErr.message).toMatch(/^file not found: /);

    // VL-SEC: a `..` detour into the excluded zone must NOT leak content and must
    // NOT surface FORBIDDEN_ZONE — the tool passes the raw path straight to
    // readVaultFile, so this proves the MCP surface inherits the root-relative
    // zone fix (resolveZone(rawPath) would have said "trusted" here).
    const dotdot = await read.handler({ path: "Notes/../Private/secret.md" });
    const ddErr = dotdot.error as { code: string; retriable: boolean; message: string };
    expect(dotdot.content).toBeUndefined(); // no leaked bytes
    expect({ code: ddErr.code, retriable: ddErr.retriable }).toEqual({
      code: missErr.code,
      retriable: missErr.retriable,
    });
    expect(ddErr.message).not.toMatch(/exclud|zone|forbidden/i);
  });

  test("vault_propose_replace's description points at vault_read as the hash source, not memory_recall / ledger_status", async () => {
    const { tools } = await setup();
    const replace = tools.get("vault_propose_replace")!;
    expect(replace.description).toContain("vault_read");
    expect(replace.description).not.toContain("memory_recall / ledger_status");
  });

  test("the structured vault tools appear in the default catalog (size 15)", async () => {
    const { tools } = await setup();
    expect(tools.has("vault_propose_replace")).toBe(true);
    expect(tools.has("vault_propose_create")).toBe(true);
    expect(tools.has("vault_propose_delete")).toBe(true);
    expect(tools.has("vault_propose_move")).toBe(true);
    expect(tools.has("vault_read")).toBe(true);
    expect(tools.has("vault_list")).toBe(true);
    expect(tools.has("vault_search")).toBe(true);
    expect(tools.size).toBe(15);
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

  test("memory_forget on a CANONICAL memory returns a queued approvalId instead of tombstoning", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;
    const created = await remember.handler({ content: "canonical fact", reason: "seed" });
    await ctx.store.setStatus(created.id, "canonical", "approved as durable belief", "s1");

    const forget = tools.get("memory_forget")!;
    const result = await forget.handler({ id: created.id, reason: "dodge contradiction check" });

    expect(result.error).toBeUndefined();
    expect(result.queued).toBe(true);
    expect(typeof result.approvalId).toBe("string");
    expect(result.forgotten).toBeUndefined();

    // The memory must remain canonical and on disk (no tombstone applied).
    expect(ctx.journal.getMemory(created.id)!.status).toBe("canonical");
  });

  test("memory_retire on a WORKING memory retires it immediately", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;
    const created = await remember.handler({ content: "aging fact", reason: "seed" });
    const promote = tools.get("memory_promote")!;
    await promote.handler({ id: created.id, target_status: "working", reason: "confirmed" });

    const retire = tools.get("memory_retire")!;
    const result = await retire.handler({ id: created.id, reason: "no longer current" });

    expect(result.error).toBeUndefined();
    expect(result.id).toBe(created.id);
    expect(result.retired).toBe(true);
    expect(ctx.journal.getMemory(created.id as string)!.status).toBe("retired");

    const abs = join(vault.vaultDir, created.path as string);
    expect(readFileSync(abs, "utf8")).toContain("retired_reason: no longer current");
  });

  test("memory_retire on a CANONICAL memory returns a queued approvalId instead of retiring (audit: no agent-reachable path retires a canonical without approval)", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;
    const created = await remember.handler({ content: "canonical fact", reason: "seed" });
    await ctx.store.setStatus(created.id, "canonical", "approved as durable belief", "s1");
    const abs = join(vault.vaultDir, created.path as string);
    const before = readFileSync(abs, "utf8");

    const retire = tools.get("memory_retire")!;
    const result = await retire.handler({ id: created.id, reason: "no longer current" });

    expect(result.error).toBeUndefined();
    expect(result.queued).toBe(true);
    expect(typeof result.approvalId).toBe("string");
    expect(result.retired).toBeUndefined();

    // File unchanged, memory still canonical.
    expect(readFileSync(abs, "utf8")).toBe(before);
    expect(ctx.journal.getMemory(created.id as string)!.status).toBe("canonical");
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

  test("memory_distill with valid sources returns the id and a derivation block on the note", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;
    const a = await remember.handler({ content: "Alice prefers dark mode.", reason: "seed" });
    const b = await remember.handler({ content: "Alice prefers a compact layout.", reason: "seed" });

    const distill = tools.get("memory_distill")!;
    const result = await distill.handler({
      content: "Alice prefers dark mode and a compact layout.",
      sources: [a.id, b.id],
      reason: "summarize alice's UI preferences",
    });

    expect(result.error).toBeUndefined();
    expect(typeof result.id).toBe("string");
    expect(typeof result.path).toBe("string");

    const abs = join(vault.vaultDir, result.path as string);
    const raw = readFileSync(abs, "utf8");
    expect(raw).toContain("derivation:");
    expect(raw).toContain("distilled");

    const relations = ctx.journal.getRelationsForMemory(result.id as string);
    expect(relations).toHaveLength(2);
  });

  test("memory_distill with a missing source returns a structured INVALID_SOURCE result, not a throw", async () => {
    const { tools } = await setup();
    const distill = tools.get("memory_distill")!;

    const result = await distill.handler({
      content: "a distillation citing nothing real",
      sources: ["mem_does_not_exist"],
      reason: "summarize",
    });

    expect(result.id).toBeUndefined();
    expect(result.error).toBeTruthy();
    const error = result.error as { code: string; retriable: boolean };
    expect(error.code).toBe("INVALID_SOURCE");
    expect(error.retriable).toBe(false);
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

  test('memory_recall accepts an explicit status: "retired" and reaches the retired memory', async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;
    const created = await remember.handler({ content: "aging fact", reason: "seed" });
    const promote = tools.get("memory_promote")!;
    await promote.handler({ id: created.id, target_status: "working", reason: "confirmed" });
    const retire = tools.get("memory_retire")!;
    await retire.handler({ id: created.id, reason: "no longer current" });

    const recall = tools.get("memory_recall")!;
    const result = await recall.handler({ status: "retired" });

    // core's MemoryStatus has included "retired" since v0.3b and recall.ts
    // honors an explicit retired filter -- the MCP enum must not be the one
    // place that rejects it, or an agent can never reach a retired memory.
    expect(result.error).toBeUndefined();
    const memories = result.memories as Array<{ id: string }>;
    expect(memories.map((m) => m.id)).toContain(created.id);
  });

  test("memory_recall without a status filter still does not surface a retired memory (retired stays excluded by default)", async () => {
    const { tools } = await setup();
    const remember = tools.get("memory_remember")!;
    const created = await remember.handler({ content: "aging fact", reason: "seed" });
    const promote = tools.get("memory_promote")!;
    await promote.handler({ id: created.id, target_status: "working", reason: "confirmed" });
    const retire = tools.get("memory_retire")!;
    await retire.handler({ id: created.id, reason: "no longer current" });

    const recall = tools.get("memory_recall")!;
    const result = await recall.handler({});

    // Accepting an EXPLICIT retired filter must not weaken recall.ts's
    // EXCLUDED_BY_DEFAULT: a bare recall still must not stumble into it.
    expect(result.error).toBeUndefined();
    const memories = result.memories as Array<{ id: string }>;
    expect(memories.map((m) => m.id)).not.toContain(created.id);
  });

  test("memory_recall still rejects a status outside the enum (the enum stays closed)", async () => {
    const { tools } = await setup();
    const recall = tools.get("memory_recall")!;

    const result = await recall.handler({ status: "bogus" });

    expect(result.memories).toBeUndefined();
    expect(result.error).toBeTruthy();
    const error = result.error as { code: string };
    expect(error.code).toBe("INVALID_ARGS");
  });

  test("memory_recall returns the note CONTENT, not just the receipt (the core-loop bug)", async () => {
    const { tools } = await setup();
    await tools.get("memory_remember")!.handler({
      content: "The launch target is MARKER-7ce14142.",
      entity: "launch",
      reason: "seed",
    });
    const result = await tools.get("memory_recall")!.handler({ entity: "launch" });
    expect(result.error).toBeUndefined();
    const memories = result.memories as Array<{ content?: string | null; contentState?: string }>;
    const mem = memories[0]!;
    // The assertion v0.1's e2e never made: a fresh recall can STATE the value.
    expect(mem.content).toContain("MARKER-7ce14142");
    expect(mem.contentState).toBe("full");
  });

  test("retired memories recalled via status:'retired' include content too (0.4.1 enum + 0.4.2 content compose)", async () => {
    const { tools } = await setup();
    const r = await tools.get("memory_remember")!.handler({
      content: "Old plan: MARKER-retired-9.",
      entity: "plan",
      reason: "seed",
    });
    await tools.get("memory_promote")!.handler({ id: r.id, target_status: "working", reason: "confirmed" });
    await tools.get("memory_retire")!.handler({ id: r.id, reason: "superseded" });
    const recalled = await tools.get("memory_recall")!.handler({ status: "retired", entity: "plan" });
    expect(recalled.error).toBeUndefined();
    const memories = recalled.memories as Array<{ content?: string | null }>;
    expect(memories[0]!.content).toContain("MARKER-retired-9");
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

describe("parseNoSweep", () => {
  test("true when --no-sweep is present", () => {
    expect(parseNoSweep(["--no-sweep"])).toBe(true);
  });

  test("false when --no-sweep is absent", () => {
    expect(parseNoSweep(["--vault", "/x"])).toBe(false);
  });

  test("true when --no-sweep is present alongside --vault", () => {
    expect(parseNoSweep(["--vault", "/x", "--no-sweep"])).toBe(true);
  });

  test("--no-sweep does not disturb --vault parsing either way", () => {
    expect(parseVaultArg(["--vault", "/x", "--no-sweep"])).toBe(resolve("/x"));
    expect(parseVaultArg(["--no-sweep", "--vault", "/x"])).toBe(resolve("/x"));
  });
});
