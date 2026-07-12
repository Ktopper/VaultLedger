import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import * as YAML from "yaml";
import {
  Broker,
  Journal,
  LedgerGit,
  MemoryStore,
  PermissionsManifest,
  journalPath,
  openJournal,
  permissionsPath,
  readConfig,
  vaultLockDir,
} from "@vaultledger/core";
import { setupCommand } from "../src/commands/setup.js";
import { defaultSteps } from "../src/commands/setup.js";
import { resolveMcpServerEntry } from "../src/setup/mcpConfig.js";
import type { StepResult } from "../src/setup/types.js";

/**
 * `ledger setup` end-to-end: pins the wiring in `defaultSteps()` +
 * `setupCommand` together, AND the product's core onboarding promise —
 * `ledger setup` is print-by-default and its idempotent re-run touches
 * NOTHING outside `.ledger/` (no new git commit, no mtime changes, and — the
 * hazard WU-3's `--no-sweep` exists to prevent — no TTL sweep of expired
 * scratch memories as a side effect of merely verifying itself).
 *
 * Mirrors `packages/mcp-server/test/v01-gate.e2e.test.ts`'s style (temp
 * vault + temp HOME, real subprocess, guarded by whether dist is built) and
 * `packages/mcp-server/test/context.noSweep.test.ts`'s seeding approach
 * (an injected past `now`, `MemoryStore.remember`, close the handle).
 */

/** All file paths (relative, posix-joined, sorted) under `root`, skipping any
 * directory whose name is in `exclude`. */
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

/** Snapshot every file's mtime (in ms) under `root`, excluding `.git`/`.ledger`
 * — used to prove a re-run touches nothing in the vault tree outside those. */
function snapshotMtimes(root: string): Map<string, number> {
  const files = listFiles(root, new Set([".git", ".ledger"]));
  const map = new Map<string, number>();
  for (const f of files) map.set(f, statSync(join(root, f)).mtimeMs);
  return map;
}

function headSha(vaultDir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: vaultDir }).toString("utf8").trim();
}

/** Seed one expired scratch memory directly into the temp-HOME journal for
 * `vaultDir`, using an injected past `now` (mirrors
 * `context.noSweep.test.ts`'s seeding approach, but built from core
 * primitives directly since this test lives outside the mcp-server package
 * and has no access to its `loadServerContext`). Returns the memory id. */
async function seedExpiredScratch(vaultDir: string, env: NodeJS.ProcessEnv): Promise<string> {
  const config = readConfig(vaultDir);
  const dbPath = journalPath(config.vaultId, env);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openJournal(dbPath);
  try {
    const journal = new Journal(db);
    const git = new LedgerGit(vaultDir);
    const lockDir = vaultLockDir(config.vaultId, env);
    const manifestRaw = readFileSync(permissionsPath(vaultDir), "utf8");
    const manifest = PermissionsManifest.parse(YAML.parse(manifestRaw));
    const oldNow = () => "2020-01-01T00:00:00.000Z";
    let counter = 0;
    const genId = (prefix: string) => `${prefix}_seed${(counter += 1)}`;
    const broker = new Broker({
      vaultRoot: vaultDir,
      git,
      journal,
      manifest,
      now: oldNow,
      genId,
      patchThreshold: config.patchThreshold,
      lockDir,
    });
    const store = new MemoryStore({ broker, journal, now: oldNow, genId, vaultRoot: vaultDir });
    const { id } = await store.remember({ content: "old scratch", reason: "seed", session: "seed" });
    return id;
  } finally {
    db.close();
  }
}

function readMemoryStatus(vaultDir: string, env: NodeJS.ProcessEnv, id: string): string | undefined {
  const config = readConfig(vaultDir);
  const dbPath = journalPath(config.vaultId, env);
  const db = openJournal(dbPath);
  try {
    const journal = new Journal(db);
    return journal.getMemory(id)?.status;
  } finally {
    db.close();
  }
}

const entry = resolveMcpServerEntry();
const distBuilt = entry !== null;

if (!distBuilt) {
  // Make the skip LOUD so a clean checkout's green `pnpm test` can't hide the
  // fact that the real end-to-end coverage never ran.
  console.warn(
    "[setup.e2e.test] SKIPPED: mcp-server dist not built — run `pnpm -C packages/mcp-server build`",
  );
}

let vaultDir: string;
let homeDir: string;
let mcpConfigDir: string;

afterEach(() => {
  if (vaultDir) rmSync(vaultDir, { recursive: true, force: true });
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  if (mcpConfigDir) rmSync(mcpConfigDir, { recursive: true, force: true });
});

describe.skipIf(!distBuilt)("ledger setup e2e: real spawn, print-by-default, mutation-free re-run", () => {
  test(
    "first run verifies + writes the mcp config; second run is diagnostic-shaped, mutation-free, and leaves an expired scratch memory un-archived",
    async () => {
      vaultDir = mkdtempSync(join(tmpdir(), "vl-setup-e2e-vault-"));
      homeDir = mkdtempSync(join(tmpdir(), "vl-setup-e2e-home-"));
      mcpConfigDir = mkdtempSync(join(tmpdir(), "vl-setup-e2e-mcpcfg-"));
      const writeMcpPath = join(mcpConfigDir, ".mcp.json");
      // The `env` in deps is what makes the spawned smoke server open the
      // seeded journal — without it the mutation-free assertion is vacuous
      // (the spawned child would fall back to process.env's real HOME).
      const env = { ...process.env, HOME: homeDir };

      // =====================================================================
      // First run: fresh vault, --yes, --write-mcp, --json.
      // =====================================================================
      const results1: StepResult[] = await setupCommand(
        vaultDir,
        { yes: true, writeMcp: writeMcpPath, installPlugin: false, json: true },
        defaultSteps(),
        { env, out: () => {} },
      );

      expect(results1.some((r) => r.state === "failed")).toBe(false);

      const initResult1 = results1.find((r) => r.step === "init");
      expect(initResult1?.state).toBe("created");

      expect(existsSync(writeMcpPath)).toBe(true);
      const writtenConfig = JSON.parse(readFileSync(writeMcpPath, "utf8")) as {
        mcpServers: { vaultledger: { command: string; args: string[] } };
      };
      const vlEntry = writtenConfig.mcpServers.vaultledger;
      expect(vlEntry.command).toBe("node");
      expect(vlEntry.args).toEqual([entry, "--vault", resolve(vaultDir)]);

      const smokeResult1 = results1.find((r) => r.step === "smoke");
      expect(smokeResult1?.state).toBe("verified");

      // =====================================================================
      // Seed one expired scratch memory into the temp-HOME journal, then
      // capture the "before" git HEAD + vault-tree mtimes.
      // =====================================================================
      const scratchId = await seedExpiredScratch(vaultDir, env);
      expect(readMemoryStatus(vaultDir, env, scratchId)).toBe("scratch");

      const headBefore = headSha(vaultDir);
      const mtimesBefore = snapshotMtimes(vaultDir);

      // =====================================================================
      // Second run: same env/options — must be a no-op diagnostic re-run.
      // =====================================================================
      const results2: StepResult[] = await setupCommand(
        vaultDir,
        { yes: true, writeMcp: writeMcpPath, installPlugin: false, json: true },
        defaultSteps(),
        { env, out: () => {} },
      );

      expect(results2.some((r) => r.state === "failed")).toBe(false);

      // (a) diagnostic-shaped: init already, smoke verified.
      const initResult2 = results2.find((r) => r.step === "init");
      expect(initResult2).toEqual({ step: "init", state: "already", detail: "already initialized" });
      const smokeResult2 = results2.find((r) => r.step === "smoke");
      expect(smokeResult2?.state).toBe("verified");

      // (b) no new git commit.
      expect(headSha(vaultDir)).toBe(headBefore);

      // (c) no mtime change in the vault tree outside .ledger/ + .git/.
      const mtimesAfter = snapshotMtimes(vaultDir);
      expect([...mtimesAfter.keys()].sort()).toEqual([...mtimesBefore.keys()].sort());
      for (const [path, before] of mtimesBefore) {
        expect(mtimesAfter.get(path), `expected ${path} mtime unchanged`).toBe(before);
      }

      // (d) the seeded expired scratch memory is still un-archived — proves
      // the smoke spawn ran with --no-sweep both times.
      expect(readMemoryStatus(vaultDir, env, scratchId)).toBe("scratch");
    },
    30_000,
  );
});

test.skipIf(distBuilt)("setup e2e skipped: mcp-server dist not built (run `pnpm build` first)", () => {
  expect(distBuilt).toBe(false);
});
