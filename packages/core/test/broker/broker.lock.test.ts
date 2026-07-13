import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Broker } from "../../src/broker/broker.js";
import { LedgerGit } from "../../src/broker/git.js";
import { Journal } from "../../src/journal/journal.js";
import { openJournal } from "../../src/journal/db.js";
import { UNSAFE_NO_LOCK, type LockDirOption } from "../../src/concurrency/lock.js";
import type { PermissionsManifest } from "../../src/schemas/manifest.js";

const MANIFEST: PermissionsManifest = {
  version: 1,
  mode: "assisted",
  zones: {
    agent: ["Agent/**"],
    scratch: ["Agent/Scratch/**"],
    excluded: ["Private/**"],
    trusted: ["**"],
  },
  overrides: [],
};

function makeClock(seed: number): { now: () => string; genId: (prefix: string) => string } {
  let tick = seed;
  let counter = seed;
  return {
    now: () => {
      tick += 1;
      return new Date(2026, 0, 1, 0, 0, 0, tick).toISOString();
    },
    genId: (prefix: string) => {
      counter += 1;
      return `${prefix}_${counter}`;
    },
  };
}

/** Build two independent "process" stand-ins over the SAME vault + git repo,
 * each with its own LedgerGit (so they don't share LedgerGit's in-process
 * promise-chain mutex — a real second process wouldn't) and own in-memory
 * journal, optionally sharing `lockDir`. */
async function makeTwoBrokers(
  vaultRoot: string,
  lockDir: LockDirOption,
): Promise<{ brokerA: Broker; brokerB: Broker }> {
  const gitA = new LedgerGit(vaultRoot);
  const gitB = new LedgerGit(vaultRoot);
  const dbA = openJournal(":memory:");
  const dbB = openJournal(":memory:");
  const journalA = new Journal(dbA);
  const journalB = new Journal(dbB);
  const brokerA = new Broker({
    vaultRoot,
    git: gitA,
    journal: journalA,
    manifest: MANIFEST,
    ...makeClock(0),
    lockDir,
  });
  const brokerB = new Broker({
    vaultRoot,
    git: gitB,
    journal: journalB,
    manifest: MANIFEST,
    ...makeClock(1000),
    lockDir,
  });
  return { brokerA, brokerB };
}

function countLedgerCommits(vaultRoot: string): number {
  const log = execSync("git log --format=%s", { cwd: vaultRoot, encoding: "utf8" });
  return log
    .split("\n")
    .filter((line) => line.startsWith("ledger:")).length;
}

function porcelainStatus(vaultRoot: string): string {
  return execSync("git status --porcelain", { cwd: vaultRoot, encoding: "utf8" }).trim();
}

describe("Broker + vault lock (two brokers over one vault, simulating two processes)", () => {
  let dir: string | undefined;
  let lockDir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
    if (lockDir) {
      rmSync(lockDir, { recursive: true, force: true });
      lockDir = undefined;
    }
  });

  test("with lockDir set: concurrent creates of two different files from two brokers land cleanly, every time", async () => {
    for (let i = 0; i < 5; i++) {
      const vaultRoot = mkdtempSync(join(tmpdir(), "vl-lockbroker-"));
      const thisLockDir = mkdtempSync(join(tmpdir(), "vl-lockdir-"));
      const bootstrap = new LedgerGit(vaultRoot);
      await bootstrap.init();

      const { brokerA, brokerB } = await makeTwoBrokers(vaultRoot, thisLockDir);

      const [resultA, resultB] = await Promise.all([
        brokerA.apply({
          op: "create",
          path: `Agent/Memory/a-${i}.md`,
          content: "# A\n",
          reason: "test create A",
          session: "sA",
        }),
        brokerB.apply({
          op: "create",
          path: `Agent/Memory/b-${i}.md`,
          content: "# B\n",
          reason: "test create B",
          session: "sB",
        }),
      ]);

      expect(resultA.ok).toBe(true);
      expect(resultB.ok).toBe(true);
      expect(porcelainStatus(vaultRoot)).toBe("");
      expect(countLedgerCommits(vaultRoot)).toBe(2);
      expect(existsSync(join(vaultRoot, `Agent/Memory/a-${i}.md`))).toBe(true);
      expect(existsSync(join(vaultRoot, `Agent/Memory/b-${i}.md`))).toBe(true);

      rmSync(vaultRoot, { recursive: true, force: true });
      rmSync(thisLockDir, { recursive: true, force: true });
    }
  }, 30000);

  test("control: a Broker constructed with NO lockDir behaves exactly as before (unaffected)", async () => {
    dir = mkdtempSync(join(tmpdir(), "vl-lockbroker-control-"));
    const bootstrap = new LedgerGit(dir);
    await bootstrap.init();

    const { brokerA } = await makeTwoBrokers(dir, UNSAFE_NO_LOCK);

    const result = await brokerA.apply({
      op: "create",
      path: "Agent/Memory/solo.md",
      content: "# solo\n",
      reason: "test create solo",
      session: "sA",
    });

    expect(result.ok).toBe(true);
    expect(existsSync(join(dir, "Agent/Memory/solo.md"))).toBe(true);
  });
});
