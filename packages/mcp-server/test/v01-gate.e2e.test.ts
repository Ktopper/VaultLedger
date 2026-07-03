import { afterEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatch } from "diff";
import matter from "gray-matter";
import { hashFile, LedgerGit } from "@vaultledger/core";
import { initCommand, undoCommand } from "@vaultledger/cli";
import { loadServerContext, type ServerContext } from "../src/context.js";
import { createServer } from "../src/index.js";

/**
 * The v0.1 gate (spec §1's six-step scenario), driven end-to-end through the
 * REAL public surfaces: the CLI's testable command functions (`initCommand`,
 * `undoCommand`) and the MCP server's tool dispatch (`createServer(ctx).callTool`,
 * the exact function a real CallTool JSON-RPC request hits). The only
 * internals this test reaches into are read-only: journal queries and git log,
 * used purely for assertions (never to drive a mutation around the broker).
 */

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

/** All file paths (relative, posix-joined, sorted) under `root`, skipping any
 * directory whose name is in `exclude`. Used to prove init touches nothing
 * outside `.ledger/` + `.git/`. */
function listFiles(root: string, exclude: Set<string>): string[] {
  const out: string[] = [];
  function walk(dir: string, rel: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (exclude.has(entry.name)) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, relPath);
      } else if (entry.isFile()) {
        out.push(relPath);
      }
    }
  }
  walk(root, "");
  return out.sort();
}

/** Snapshot every file's exact bytes under `root` (excluding `.git`/`.ledger`),
 * keyed by relative path. */
function snapshot(root: string): Map<string, Buffer> {
  const files = listFiles(root, new Set([".git", ".ledger"]));
  const map = new Map<string, Buffer>();
  for (const f of files) map.set(f, readFileSync(join(root, f)));
  return map;
}

function parseToolResult<T>(result: { content: Array<{ type: string; text?: string }> }): T {
  const text = result.content[0]?.text;
  if (typeof text !== "string") throw new Error("tool result had no text content");
  return JSON.parse(text) as T;
}

let vaultDir: string;
let homeDir: string;
const openDbs: ServerContext[] = [];

afterEach(() => {
  for (const ctx of openDbs) {
    try {
      ctx.db.close();
    } catch {
      // already closed — fine.
    }
  }
  openDbs.length = 0;
  if (vaultDir) rmSync(vaultDir, { recursive: true, force: true });
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
});

describe("v0.1 gate: governed-write loop (spec §1 six-step scenario)", () => {
  test("init -> remember/propose -> governance -> cross-session recall -> undo -> excluded rejection", async () => {
    vaultDir = mkdtempSync(join(tmpdir(), "vl-gate-vault-"));
    homeDir = mkdtempSync(join(tmpdir(), "vl-gate-home-"));
    const env = { HOME: homeDir } as NodeJS.ProcessEnv;
    const clock = makeClock();

    // --- Fixture: a vault with EXISTING user notes and NOTHING in .ledger yet.
    mkdirSync(join(vaultDir, "Notes"), { recursive: true });
    mkdirSync(join(vaultDir, "Projects"), { recursive: true });
    mkdirSync(join(vaultDir, "Agent"), { recursive: true });
    mkdirSync(join(vaultDir, "Private"), { recursive: true });

    const welcomeContent =
      "# Welcome\n\nThis is your vault. See [[Projects/Nova]] for the current project.\n";
    const novaContent = "# Nova Project\n\nStatus: kickoff.\nOwner: unassigned.\n";
    const secretContent = "# Secret\n\nDo not touch.\n";
    writeFileSync(join(vaultDir, "Notes", "Welcome.md"), welcomeContent, "utf8");
    writeFileSync(join(vaultDir, "Projects", "Nova.md"), novaContent, "utf8");
    writeFileSync(join(vaultDir, "Private", "secret.md"), secretContent, "utf8");

    const preInitSnapshot = snapshot(vaultDir);
    expect(existsSync(join(vaultDir, ".ledger"))).toBe(false);

    // =====================================================================
    // STEP 1: init — read-only scan, then writes ONLY .ledger/ + .git/.
    // =====================================================================
    const initResult = await initCommand(vaultDir, {
      confirm: true,
      rand: () => "e2e00001",
      now: clock.now,
      genId: clock.genId,
      env,
      out: () => {},
    });
    expect(initResult.created).toBe(true);

    expect(existsSync(join(vaultDir, ".ledger", "config.json"))).toBe(true);
    expect(existsSync(join(vaultDir, ".ledger", "permissions.yaml"))).toBe(true);
    expect(existsSync(join(vaultDir, ".git"))).toBe(true);

    // Pre-existing user notes are byte-for-byte unchanged.
    const postInitSnapshot = snapshot(vaultDir);
    expect(postInitSnapshot.size).toBe(preInitSnapshot.size);
    for (const [relPath, before] of preInitSnapshot) {
      const after = postInitSnapshot.get(relPath);
      expect(after, `expected ${relPath} to still exist after init`).toBeDefined();
      expect(after!.equals(before), `expected ${relPath} bytes unchanged by init`).toBe(true);
    }
    // Nothing NEW was written into user folders either (only .ledger/+.git/,
    // both excluded from the snapshot walk above).
    expect([...postInitSnapshot.keys()].sort()).toEqual(
      ["Notes/Welcome.md", "Private/secret.md", "Projects/Nova.md"].sort(),
    );

    // =====================================================================
    // STEP 2: Session A — remember 3 facts + propose 1 trusted edit.
    // =====================================================================
    const ctxA = await loadServerContext(vaultDir, {
      ...(env ? { env } : {}),
      now: clock.now,
      genId: clock.genId,
      session: "mcp-A",
    });
    openDbs.push(ctxA);
    const { callTool: callToolA } = createServer(ctxA);

    const facts = [
      { content: "Bob prefers dark mode.", entity: "bob", reason: "user stated preference" },
      { content: "Nova's launch target is Q4.", entity: "nova", reason: "user shared a deadline" },
      { content: "Alice is the design lead on Nova.", entity: "alice", reason: "user introduced a teammate" },
    ];
    const remembered: Array<{ id: string; path: string }> = [];
    for (const fact of facts) {
      const res = await callToolA("memory_remember", {
        content: fact.content,
        entity: fact.entity,
        reason: fact.reason,
      });
      expect(res.isError, `memory_remember failed: ${JSON.stringify(res)}`).toBeFalsy();
      const parsed = parseToolResult<{ id: string; path: string; status: string }>(res);
      expect(parsed.status).toBe("scratch");
      remembered.push({ id: parsed.id, path: parsed.path });
    }
    expect(remembered.length).toBe(3);

    const novaAbs = join(vaultDir, "Projects", "Nova.md");
    const novaBefore = readFileSync(novaAbs, "utf8");
    const novaAfter = novaBefore.replace("Owner: unassigned.", "Owner: Alice.");
    const novaPatch = createPatch("Projects/Nova.md", novaBefore, novaAfter);
    const novaHash = hashFile(novaAbs);
    const proposeResult = await callToolA("vault_propose_edit", {
      path: "Projects/Nova.md",
      patch: novaPatch,
      expected_hash: novaHash,
      reason: "assign an owner",
    });
    expect(proposeResult.isError, `vault_propose_edit failed: ${JSON.stringify(proposeResult)}`).toBeFalsy();
    const proposeParsed = parseToolResult<{ queued: boolean; approvalId: string }>(proposeResult);
    expect(proposeParsed.queued).toBe(true);
    expect(typeof proposeParsed.approvalId).toBe("string");

    // =====================================================================
    // STEP 3: governance assertions.
    // =====================================================================
    // The trusted edit is QUEUED, not applied: bytes on disk unchanged.
    expect(readFileSync(novaAbs, "utf8")).toBe(novaBefore);

    const statusResult = await callToolA("ledger_status", {});
    expect(statusResult.isError).toBeFalsy();
    const statusParsed = parseToolResult<{ pendingApprovals: unknown[] }>(statusResult);
    expect(statusParsed.pendingApprovals.length).toBe(1);

    // Each of the 3 memories carries provenance frontmatter written to the file.
    for (let i = 0; i < remembered.length; i++) {
      const mem = remembered[i]!;
      const abs = join(vaultDir, mem.path);
      const raw = readFileSync(abs, "utf8");
      const parsed = matter(raw);
      const ledger = parsed.data.ledger as Record<string, unknown>;
      expect(ledger.status, `memory ${i} status`).toBe("scratch");
      expect(ledger.source, `memory ${i} source`).toBe("mcp-A");
      expect(ledger.id, `memory ${i} id`).toBe(mem.id);
      expect(typeof ledger.reason, `memory ${i} reason present`).toBe("string");
      expect((ledger.reason as string).length).toBeGreaterThan(0);
    }

    // Exactly one `ledger:` commit per applied transaction: 3 remembers = 3
    // commits. The propose_edit made NO commit (it only queued).
    const git = new LedgerGit(vaultDir);
    const ledgerCommits = await git.listLedgerCommits();
    expect(ledgerCommits.length).toBe(3);

    // Capture the create txn for the FIRST remembered fact now (while ctxA's
    // journal handle is open) — undone in step 5. This is a read-only journal
    // query for assertion/setup purposes, not a mutation path.
    const createTxns = ctxA.journal
      .listTransactions({ session: "mcp-A" })
      .filter((t) => t.op === "create");
    expect(createTxns.length).toBe(3);
    const targetTxn = createTxns.find((t) => t.path === remembered[0]!.path);
    expect(targetTxn, "expected a create txn for the first remembered fact").toBeDefined();
    const undoTxnId = targetTxn!.id;

    ctxA.db.close();

    // =====================================================================
    // STEP 4: Session B — recall returns Session A's memories with provenance.
    // =====================================================================
    const ctxB = await loadServerContext(vaultDir, {
      env,
      now: clock.now,
      genId: clock.genId,
      session: "mcp-B",
    });
    openDbs.push(ctxB);
    const { callTool: callToolB } = createServer(ctxB);

    const recallResult = await callToolB("memory_recall", {});
    expect(recallResult.isError).toBeFalsy();
    const recallParsed = parseToolResult<{
      memories: Array<{ id: string; entity: string | null; source: string | null; tags: string[] }>;
    }>(recallResult);

    for (const mem of remembered) {
      const found = recallParsed.memories.find((m) => m.id === mem.id);
      expect(found, `expected recall to return memory ${mem.id} created by session A`).toBeDefined();
      // Cross-session persistence: provenance still says "mcp-A", proving this
      // wasn't re-attributed to the reading session ("mcp-B").
      expect(found!.source).toBe("mcp-A");
    }
    const boB = recallParsed.memories.find((m) => m.entity === "bob");
    expect(boB).toBeDefined();

    ctxB.db.close();

    // =====================================================================
    // STEP 5: undo restores prior bytes exactly.
    // =====================================================================
    const undoTargetAbs = join(vaultDir, remembered[0]!.path);
    expect(existsSync(undoTargetAbs)).toBe(true);

    const undoResult = await undoCommand(vaultDir, undoTxnId, { env, now: clock.now, genId: clock.genId });
    expect(undoResult.ok, `undo failed: ${JSON.stringify(undoResult)}`).toBe(true);
    if (!undoResult.ok) throw new Error("unreachable"); // narrow for TS
    expect("code" in undoResult).toBe(false);

    expect(existsSync(undoTargetAbs)).toBe(false);

    const ctxC = await loadServerContext(vaultDir, {
      env,
      now: clock.now,
      genId: clock.genId,
      session: "mcp-C",
    });
    openDbs.push(ctxC);
    const { callTool: callToolC } = createServer(ctxC);

    const recallAfterUndo = await callToolC("memory_recall", {});
    const recallAfterUndoParsed = parseToolResult<{ memories: Array<{ id: string }> }>(recallAfterUndo);
    expect(recallAfterUndoParsed.memories.some((m) => m.id === remembered[0]!.id)).toBe(false);
    expect(recallAfterUndoParsed.memories.some((m) => m.id === remembered[1]!.id)).toBe(true);
    expect(recallAfterUndoParsed.memories.some((m) => m.id === remembered[2]!.id)).toBe(true);

    // =====================================================================
    // STEP 6: excluded-path write is cleanly rejected (FORBIDDEN_ZONE).
    // =====================================================================
    const secretAbs = join(vaultDir, "Private", "secret.md");
    const secretBefore = readFileSync(secretAbs, "utf8");
    const secretPatch = createPatch("Private/secret.md", secretBefore, secretBefore + "\nEXTRA\n");
    const secretHash = hashFile(secretAbs);

    const excludedResult = await callToolC("vault_propose_edit", {
      path: "Private/secret.md",
      patch: secretPatch,
      expected_hash: secretHash,
      reason: "attempt to touch an excluded path",
    });
    expect(excludedResult.isError).toBe(true);
    const excludedParsed = parseToolResult<{
      error: { code: string; message: string; retriable: boolean };
    }>(excludedResult);
    expect(excludedParsed.error.code).toBe("FORBIDDEN_ZONE");

    // Not queued: pendingApprovals is still exactly the 1 from step 3/4.
    const statusAfterExcluded = await callToolC("ledger_status", {});
    const statusAfterExcludedParsed = parseToolResult<{ pendingApprovals: unknown[] }>(statusAfterExcluded);
    expect(statusAfterExcludedParsed.pendingApprovals.length).toBe(1);

    // File untouched.
    expect(readFileSync(secretAbs, "utf8")).toBe(secretBefore);

    ctxC.db.close();
  });
});
