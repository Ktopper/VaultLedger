import { afterEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { journalPath, openJournal, probeGitRepo, readConfig } from "@vaultledger/core";
import { runDoctor } from "../src/commands/doctor.js";
import type { CheckResult } from "../src/commands/doctorReport.js";
import { makeInitializedVault, type TestVault } from "./helpers.js";

/**
 * `ledger doctor` end-to-end. Two intents:
 *  1. behavioural — healthy vault clean-passes, broken vault fails+cascades,
 *     `--strict` promotes warn→exit 1, and the JSON shape is just a serialization
 *     of the same runDoctor result.
 *  2. LOAD-BEARING (spec §7): doctor is a diagnosis command — it MUST leave the
 *     vault tree, the app-support dir, and git HEAD byte-identical. The
 *     substantive app-support byte-identity proof is the WAL-mode-journal
 *     fixture (its app-support dir actually contains a built journal.db, so the
 *     snapshot comparison is non-vacuous); the absent-journal fixture proves
 *     the complementary guarantee — that doctor never create-on-opens the DB —
 *     via the explicit `existsSync(journal) === false` assertion (its
 *     app-support snapshot is empty-vs-empty and intentionally not the crux).
 */

// Returns a sorted map of relativePath -> `${size}:${mtimeMs}` for every file
// under `root`, optionally skipping a top-level dir name (e.g. ".git", whose
// internals we don't assert on).
function snapshot(root: string, skipTop?: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relative(root, full);
      if (skipTop && rel.split("/")[0] === skipTop) continue;
      if (e.isDirectory()) walk(full);
      else {
        const s = statSync(full);
        out[rel] = `${s.size}:${s.mtimeMs}`;
      }
    }
  };
  walk(root);
  return out;
}

/** vaultId of an initialized test vault (read from its config, never hardcoded). */
function vaultIdOf(v: TestVault): string {
  return readConfig(v.vaultDir).vaultId;
}

/** Build a real journal in the isolated app-support path (WAL + schema). */
function buildJournal(v: TestVault): void {
  const env = v.deps.env as NodeJS.ProcessEnv;
  const jp = journalPath(vaultIdOf(v), env);
  mkdirSync(dirname(jp), { recursive: true });
  const db = openJournal(jp);
  db.close();
}

function byName(checks: CheckResult[], name: string): CheckResult {
  const c = checks.find((x) => x.name === name);
  if (!c) throw new Error(`no check named ${name}`);
  return c;
}

describe("ledger doctor e2e", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  async function initializedVault(): Promise<TestVault> {
    const v = await makeInitializedVault();
    cleanups.push(v.cleanup);
    return v;
  }

  test("all-healthy vault → all ok/info, exit 0", async () => {
    const v = await initializedVault();
    buildJournal(v);

    const { checks, exitCode } = await runDoctor(
      v.vaultDir,
      { json: false, strict: false },
      { env: v.deps.env },
    );

    expect(exitCode).toBe(0);
    for (const c of checks) {
      expect(["ok", "info"], `check ${c.name} → ${c.status}: ${c.detail}`).toContain(c.status);
    }
    // the journal build must have landed in the path runDoctor reads
    expect(byName(checks, "journal").status).toBe("ok");
  });

  test("deliberately-broken (uninitialized) vault → config fails, vault-dependent checks skip, exit 1", async () => {
    const broken = mkdtempSync(join(tmpdir(), "vl-broken-"));
    cleanups.push(() => rmSync(broken, { recursive: true, force: true }));

    const { checks, exitCode } = await runDoctor(
      broken,
      { json: false, strict: false },
      { env: { HOME: broken } as NodeJS.ProcessEnv },
    );

    expect(exitCode).toBe(1);
    expect(byName(checks, "config").status).toBe("fail");

    // vault-dependent checks cascade to skipped
    for (const name of ["permissions", "zone-integrity", "journal", "lock", "bridge", "plugin"]) {
      expect(byName(checks, name).status, `${name} should skip`).toBe("skipped");
    }
    // vault-independent checks still run (NOT skipped)
    for (const name of ["git", "mcp", "versions", "sync-artifacts"]) {
      expect(byName(checks, name).status, `${name} should have run`).not.toBe("skipped");
    }
  });

  test("--strict promotes warn → exit 1 (same vault, non-strict → exit 0)", async () => {
    // initialized vault with NO journal built → journal check is `warn`.
    const v = await initializedVault();

    const lenient = await runDoctor(v.vaultDir, { json: false, strict: false }, { env: v.deps.env });
    expect(byName(lenient.checks, "journal").status).toBe("warn");
    expect(lenient.exitCode).toBe(0); // warn alone doesn't fail

    const strict = await runDoctor(v.vaultDir, { json: false, strict: true }, { env: v.deps.env });
    expect(byName(strict.checks, "journal").status).toBe("warn");
    expect(strict.exitCode).toBe(1); // strict promotes the warn
  });

  test("--json-shape parity: returned object is checks[]+numeric exitCode, statuses match a plain run", async () => {
    const v = await initializedVault();
    buildJournal(v);

    const result = await runDoctor(v.vaultDir, { json: true, strict: false }, { env: v.deps.env });
    expect(Array.isArray(result.checks)).toBe(true);
    expect(typeof result.exitCode).toBe("number");

    // runDoctor is the single source of truth; the json flag is pure serialization.
    const plain = await runDoctor(v.vaultDir, { json: false, strict: false }, { env: v.deps.env });
    expect(result.checks.map((c) => [c.name, c.status])).toEqual(
      plain.checks.map((c) => [c.name, c.status]),
    );
    expect(result.exitCode).toBe(plain.exitCode);
  });

  describe("LOAD-BEARING: mutation-free guarantee (spec §7)", () => {
    async function assertNoMutation(
      v: TestVault,
      extra?: (v: TestVault) => Promise<void> | void,
    ): Promise<void> {
      const env = v.deps.env as NodeJS.ProcessEnv;
      const appSupport = dirname(journalPath(vaultIdOf(v), env));

      const vaultBefore = snapshot(v.vaultDir, ".git");
      const appBefore = snapshot(appSupport);
      const headBefore = (await probeGitRepo(v.vaultDir)).head;

      await runDoctor(v.vaultDir, { json: false, strict: false }, { env });

      const vaultAfter = snapshot(v.vaultDir, ".git");
      const appAfter = snapshot(appSupport);
      const headAfter = (await probeGitRepo(v.vaultDir)).head;

      expect(vaultAfter).toEqual(vaultBefore);
      expect(appAfter).toEqual(appBefore);
      expect(headAfter).toEqual(headBefore); // both null on a no-commit repo is fine

      if (extra) await extra(v);
    }

    test("absent-journal: doctor never create-on-opens the journal", async () => {
      const v = await initializedVault();
      const env = v.deps.env as NodeJS.ProcessEnv;
      const jp = journalPath(vaultIdOf(v), env);
      expect(existsSync(jp)).toBe(false); // precondition

      await assertNoMutation(v, () => {
        // doctor must NOT have materialized the journal
        expect(existsSync(jp)).toBe(false);
      });
    });

    test("WAL-mode journal: probe materializes no new -wal/-shm sidecars, touches no mtime", async () => {
      const v = await initializedVault();
      buildJournal(v); // build BEFORE snapshotting so its own sidecars are in `before`
      await assertNoMutation(v);
    });
  });
});
