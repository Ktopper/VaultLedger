import { describe, expect, test, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as YAML from "yaml";
import matter from "gray-matter";
import {
  DEFAULT_LEDGER_CONFIG,
  LedgerGit,
  PermissionsManifest,
  mintVaultId,
  permissionsPath,
  writeConfig,
  recall,
} from "../../src/index.js";
import { openVault } from "../../src/host/openVault.js";

interface TestVault {
  vaultDir: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

/** Build a minimal but real VaultLedger vault on disk + a temp HOME so the
 * journal (app-support dir keyed by vaultId) never touches the real
 * ~/Library/Application Support/VaultLedger. */
async function makeTestVault(rand: () => string = () => "test1234"): Promise<TestVault> {
  const vaultDir = mkdtempSync(join(tmpdir(), "vl-openvault-"));
  const homeDir = mkdtempSync(join(tmpdir(), "vl-openvault-home-"));

  mkdirSync(join(vaultDir, "Notes"), { recursive: true });
  writeFileSync(join(vaultDir, "Notes", "trusted.md"), "# Trusted note\n\nSome content.\n", "utf8");

  const manifest = PermissionsManifest.parse({
    mode: "assisted",
    zones: {
      trusted: ["**"],
      agent: ["Agent/**"],
      scratch: ["Agent/Scratch/**"],
      excluded: ["Private/**"],
    },
    overrides: [],
  });

  const git = new LedgerGit(vaultDir);
  await git.init();

  mkdirSync(join(vaultDir, ".ledger"), { recursive: true });
  writeFileSync(permissionsPath(vaultDir), YAML.stringify(manifest), "utf8");
  writeConfig(vaultDir, { ...DEFAULT_LEDGER_CONFIG, vaultId: mintVaultId(rand) });

  const env = { HOME: homeDir } as NodeJS.ProcessEnv;
  return {
    vaultDir,
    homeDir,
    env,
    cleanup: () => {
      rmSync(vaultDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

/** Build valid `ledger:` provenance frontmatter for a seeded memory note,
 * via gray-matter's own stringifier (matching the convention used elsewhere
 * in this repo) so the ISO `created` date round-trips as a STRING through
 * YAML rather than being implicitly resolved to a Date/timestamp scalar. */
function seedNoteBody(id: string, body: string): string {
  return matter.stringify(body, {
    ledger: {
      id,
      status: "scratch",
      created: "2026-01-01T00:00:00.000Z",
      source: "seed-session",
      reason: "seed",
      confidence: "medium",
      supersedes: null,
      expires: null,
    },
  });
}

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

describe("openVault", () => {
  let vault: TestVault | undefined;

  afterEach(() => {
    if (vault) {
      vault.cleanup();
      vault = undefined;
    }
  });

  test("returns a fully wired VaultContext: store.remember works, recall finds it, close() closes the db", async () => {
    vault = await makeTestVault();
    const { now, genId } = makeClock();

    const ctx = await openVault(vault.vaultDir, { now, genId, env: vault.env, session: "sess-1" });

    expect(ctx.vaultRoot).toBe(vault.vaultDir);
    expect(ctx.session).toBe("sess-1");
    expect(ctx.lockDir).toContain(ctx.config.vaultId);

    const remembered = await ctx.store.remember({
      content: "# A fact\n",
      reason: "test remember",
      session: "sess-1",
    });
    expect(remembered.id).toBeDefined();

    const found = recall(ctx.journal, {}, now, ctx.manifest);
    expect(found.some((m) => m.id === remembered.id)).toBe(true);

    const closeSpy = vi.spyOn(ctx.db, "close");
    ctx.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  test("ensureJournal + reconcile run at open: an empty journal is rebuilt from a seeded note + commit", async () => {
    vault = await makeTestVault();
    const { now, genId } = makeClock();

    // Seed a memory note + commit directly via git, WITHOUT going through a
    // context (simulating a vault that already has agent-zone content but a
    // brand-new/empty journal — the auto-heal case).
    const git = new LedgerGit(vault.vaultDir);
    mkdirSync(join(vault.vaultDir, "Agent", "Memory"), { recursive: true });
    const notePath = join(vault.vaultDir, "Agent", "Memory", "seed.md");
    writeFileSync(notePath, seedNoteBody("mem_seed", "# Seeded memory\n"), "utf8");
    await git.commitFile("Agent/Memory/seed.md", "ledger: create seed.md seed-session");

    const ctx = await openVault(vault.vaultDir, { now, genId, env: vault.env });
    try {
      const mem = ctx.journal.getMemory("mem_seed");
      expect(mem).not.toBeNull();
      expect(mem?.path).toBe("Agent/Memory/seed.md");

      const txns = ctx.journal.listTransactions({});
      expect(txns.length).toBeGreaterThan(0);
    } finally {
      ctx.close();
    }
  });

  test("idempotent double-open: opening the same vault twice converges to identical memory + transaction row counts (no duplicates)", async () => {
    vault = await makeTestVault();
    const { now, genId } = makeClock();

    const git = new LedgerGit(vault.vaultDir);
    mkdirSync(join(vault.vaultDir, "Agent", "Memory"), { recursive: true });
    writeFileSync(
      join(vault.vaultDir, "Agent", "Memory", "seed.md"),
      seedNoteBody("mem_seed2", "# Seeded memory 2\n"),
      "utf8",
    );
    await git.commitFile("Agent/Memory/seed.md", "ledger: create seed.md seed-session");

    const ctx1 = await openVault(vault.vaultDir, { now, genId, env: vault.env });
    const memCount1 = ctx1.journal.listTransactions({}).length;
    const memRowCount1 = ctx1.journal.queryMemories({ limit: 1000 }).length;
    ctx1.close();

    const ctx2 = await openVault(vault.vaultDir, { now, genId, env: vault.env });
    const memCount2 = ctx2.journal.listTransactions({}).length;
    const memRowCount2 = ctx2.journal.queryMemories({ limit: 1000 }).length;
    ctx2.close();

    expect(memCount2).toBe(memCount1);
    expect(memRowCount2).toBe(memRowCount1);
    expect(memRowCount1).toBe(1);
  });

  test("concurrent startup reindex converges (two openVault racing an empty journal -> no duplicate rows)", async () => {
    vault = await makeTestVault();
    const { now, genId } = makeClock();

    // Seed 3 agent-zone memory notes with valid ledger frontmatter + their
    // `ledger:` commits, but leave the journal untouched (no context has been
    // opened yet against this fresh temp HOME, so journal.db does not exist
    // for this vaultId) — BOTH racing opens must rebuild it via ensureJournal.
    const git = new LedgerGit(vault.vaultDir);
    mkdirSync(join(vault.vaultDir, "Agent", "Memory"), { recursive: true });
    const seedIds = ["mem_c1", "mem_c2", "mem_c3"];
    for (const id of seedIds) {
      writeFileSync(
        join(vault.vaultDir, "Agent", "Memory", `${id}.md`),
        seedNoteBody(id, `# Seeded memory ${id}\n`),
        "utf8",
      );
      await git.commitFile(`Agent/Memory/${id}.md`, `ledger: create ${id}.md seed-session`);
    }

    // Same vaultRoot + same env => same journalPath + same lockDir: these two
    // opens genuinely race ensureJournal/reconcile against the one journal.db
    // under WAL, simulating `ledger serve` + the MCP server starting at once.
    const [ctx1, ctx2] = await Promise.all([
      openVault(vault.vaultDir, { now, genId, env: vault.env }),
      openVault(vault.vaultDir, { now, genId, env: vault.env }),
    ]);

    try {
      const memRows1 = ctx1.journal.queryMemories({ limit: 1000 });
      expect(memRows1).toHaveLength(seedIds.length);
      expect(new Set(memRows1.map((m) => m.id)).size).toBe(seedIds.length);

      const memRows2 = ctx2.journal.queryMemories({ limit: 1000 });
      expect(memRows2).toHaveLength(seedIds.length);

      const txns = ctx1.journal.listTransactions({ limit: 1000 });
      const shas = txns.map((t) => t.commit_sha).filter((s): s is string => s !== null);
      // No duplicate transaction rows for the same commit sha: the set of
      // shas is exactly as large as the list of shas.
      expect(new Set(shas).size).toBe(shas.length);
      expect(shas.length).toBeGreaterThanOrEqual(seedIds.length);
    } finally {
      ctx1.close();
      ctx2.close();
    }
  });
});
