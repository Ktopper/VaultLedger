import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashFile, undoSession, vaultLockDir } from "@vault-ledger/core";
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

/**
 * CAPSTONE — the field task Hermes could not do: an agent takes an article that
 * was dropped, UNTRACKED, into `Inbox/` (the real Obsidian-sync shape — a file
 * that appeared on disk but was never git-committed) and files it into an
 * existing client hub `Clients/Brandit/`, driven entirely through the real
 * agent surface (vault_list -> vault_search -> vault_read -> vault_propose_move
 * -> approve). This is the cycle's acceptance gate.
 *
 * The source MUST be untracked: a pre-committed source would mask the B1
 * baseline-commit path (the data-loss bug where an untracked file, once
 * unlinked by the move, is unrecoverable because git never held a copy). The
 * capstone therefore asserts the untracked source round-trips byte-identically
 * through move + undo, which is only possible if applyMove baseline-committed
 * it first.
 */
describe("CAPSTONE: file the untracked Inbox article into the Brandit hub", () => {
  test("list -> search/read -> move -> approve -> Inbox clean -> undo restores", async () => {
    vault = await makeTestVault();
    const { now, genId } = makeClock();
    ctx = await loadServerContext(vault.vaultDir, {
      ...vault.deps,
      now,
      genId,
      session: "capstone-session",
    });
    const tools = new Map<string, ToolDef>(buildTools(ctx).map((t) => [t.name, t]));

    const article = "2026-03-brandit-logo-refresh.md";
    const inboxRel = `Inbox/${article}`;
    const destRel = `Clients/Brandit/${article}`;
    const inboxAbs = join(vault.vaultDir, "Inbox", article);
    const destAbs = join(vault.vaultDir, "Clients", "Brandit", article);
    const UNIQUE = "zephyr-brandit-9f3a";
    const articleBody = `# Brandit — Q1 logo refresh brief\n\nThe Brandit account asked for a quarterly logo refresh. Deliverables due Friday.\nTracking token: ${UNIQUE}\n`;

    // --- Seed the incident shape -------------------------------------------
    // The Inbox article: seeded on disk, deliberately NOT git-committed (the
    // real Obsidian-synced shape — an untracked file).
    mkdirSync(join(vault.vaultDir, "Inbox"), { recursive: true });
    writeFileSync(inboxAbs, articleBody, "utf8");
    // The existing Brandit client hub (a trusted zone) with an existing note.
    mkdirSync(join(vault.vaultDir, "Clients", "Brandit"), { recursive: true });
    writeFileSync(
      join(vault.vaultDir, "Clients", "Brandit", "_hub.md"),
      "# Brandit — client hub\n",
      "utf8",
    );

    // A governed memory seeded under a SEPARATE session so the session-scoped
    // undo of the move at the end does not revert it — it must survive to prove
    // recall still works after the whole loop.
    await ctx.store.remember({
      content: "Brandit is a priority client account.",
      entity: "brandit",
      reason: "seed the recall check",
      session: "seed-session",
    });

    // The source is genuinely UNTRACKED — the crux of the B1 shape. If this were
    // non-null, the capstone would be masking the data-loss path.
    expect(await ctx.git.fileAtHead(inboxRel)).toBeNull();

    // --- 1. vault_list the Inbox -> find the article -----------------------
    const listRes = await tools.get("vault_list")!.handler({ path: "Inbox" });
    expect(listRes.error).toBeUndefined();
    const inboxEntries = listRes.entries as Array<{ name: string; kind: string }>;
    const found = inboxEntries.find((e) => e.name === article);
    expect(found).toBeDefined();
    expect(found!.kind).toBe("file");

    // --- 2. vault_search for a term in the article -------------------------
    const searchRes = await tools.get("vault_search")!.handler({ query: UNIQUE });
    expect(searchRes.error).toBeUndefined();
    const matches = searchRes.matches as Array<{ path: string }>;
    expect(matches.some((m) => m.path === inboxRel)).toBe(true);

    // --- 3. vault_read the article -> identify + pin its hash --------------
    const readRes = await tools.get("vault_read")!.handler({ path: inboxRel });
    expect(readRes.error).toBeUndefined();
    const sourceHash = readRes.hash as string;
    expect(readRes.content).toContain(UNIQUE);
    expect(sourceHash).toBe(hashFile(inboxAbs));

    // --- 4. vault_propose_move Inbox -> Clients/Brandit (implicit subdir) ---
    const moveRes = await tools.get("vault_propose_move")!.handler({
      from: inboxRel,
      to: destRel,
      expected_hash: sourceHash,
      reason: "file the incident article into the Brandit client hub",
    });
    expect(moveRes.error).toBeUndefined();
    expect(moveRes.queued).toBe(true);
    const approvalId = moveRes.approvalId as string;
    expect(typeof approvalId).toBe("string");
    // Queued only — nothing has moved yet.
    expect(existsSync(inboxAbs)).toBe(true);
    expect(existsSync(destAbs)).toBe(false);

    // --- 5. Approve (the human gate) ---------------------------------------
    const approveRes = await ctx.approvals.approve(approvalId);
    expect(approveRes).toEqual({ applied: true });

    // --- 6. Assertions -----------------------------------------------------
    // Inbox is left clean: the article is gone and vault_list reports empty.
    expect(existsSync(inboxAbs)).toBe(false);
    const inboxAfter = await tools.get("vault_list")!.handler({ path: "Inbox" });
    expect(inboxAfter.error).toBeUndefined();
    expect(inboxAfter.entries).toEqual([]);

    // The article is now in the hub with byte-identical content (hash equality),
    // and the pre-existing hub note is undisturbed.
    expect(existsSync(destAbs)).toBe(true);
    expect(hashFile(destAbs)).toBe(sourceHash);
    expect(existsSync(join(vault.vaultDir, "Clients", "Brandit", "_hub.md"))).toBe(true);

    // The untracked source was baseline-committed and the move committed: the
    // destination is now tracked at HEAD (git holds the bytes — not lost).
    expect(await ctx.git.fileAtHead(destRel)).not.toBeNull();
    expect(await ctx.git.fileAtHead(inboxRel)).toBeNull();

    // --- undo restores the article to Inbox --------------------------------
    const lockDir = vaultLockDir(ctx.config.vaultId, vault.deps.env);
    const reverted = await undoSession(
      { git: ctx.git, journal: ctx.journal, now: ctx.now, genId: ctx.genId, lockDir },
      "capstone-session",
    );
    expect(reverted.length).toBe(1); // only the move ran under this session

    // Back at Inbox, byte-identical; the hub copy is gone; hub note survives.
    expect(existsSync(inboxAbs)).toBe(true);
    expect(hashFile(inboxAbs)).toBe(sourceHash);
    expect(existsSync(destAbs)).toBe(false);
    expect(existsSync(join(vault.vaultDir, "Clients", "Brandit", "_hub.md"))).toBe(true);

    // vault_list Inbox sees the restored article again.
    const inboxRestored = await tools.get("vault_list")!.handler({ path: "Inbox" });
    const restoredNames = (inboxRestored.entries as Array<{ name: string }>).map((e) => e.name);
    expect(restoredNames).toContain(article);

    // recall still works — the seeded memory (a different session) is untouched.
    const recallRes = await tools.get("memory_recall")!.handler({ entity: "brandit" });
    expect(recallRes.error).toBeUndefined();
    const recalled = recallRes.memories as Array<{ entity?: string }>;
    expect(recalled.length).toBeGreaterThan(0);
  });
});
