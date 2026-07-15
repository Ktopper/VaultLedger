import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionsManifest, vaultLockDir, LOCK_CONFIG, permissionsPath } from "@vault-ledger/core";
import { makeInitializedVault, type TestVault } from "../helpers.js";
import { initCommand } from "../../src/commands/init.js";
import {
  runDoctor,
  mapGitProbe,
  mapMcpProbe,
  compareVersions,
  scanSyncArtifacts,
  checkZoneIntegrity,
  checkLock,
  mapJournalProbe,
  mapPluginFreshness,
  mapNativeProbe,
  nodeInEnginesRange,
} from "../../src/commands/doctor.js";

describe("runDoctor — config gate + cascade + exit code", () => {
  let v: TestVault | undefined;
  afterEach(() => { v?.cleanup(); v = undefined; });

  test("healthy initialized vault: config ok, exit 0", async () => {
    v = await makeInitializedVault();
    const { checks, exitCode } = await runDoctor(v.vaultDir, { json: false, strict: false }, { env: v.deps.env });
    const config = checks.find((c) => c.name === "config")!;
    expect(config.status).toBe("ok");
    expect(exitCode).toBe(0);
  });

  test("uninitialized dir: config fails, vault-dependent checks skipped, exit 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vl-empty-"));
    try {
      const { checks, exitCode } = await runDoctor(dir, { json: false, strict: false }, {});
      expect(checks.find((c) => c.name === "config")!.status).toBe("fail");
      expect(checks.find((c) => c.name === "journal")!.status).toBe("skipped");
      expect(checks.find((c) => c.name === "permissions")!.status).toBe("skipped");
      expect(exitCode).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("mapGitProbe", () => {
  test("gitWorks:false → fail", () => {
    const r = mapGitProbe({ isRepo: false, gitWorks: false, head: null });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("git isn't working");
    expect(r.remediation).toContain("install git");
  });

  test("isRepo:false → fail", () => {
    const r = mapGitProbe({ isRepo: false, gitWorks: true, head: null });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("not a git repo");
    expect(r.remediation).toContain("ledger setup");
  });

  test("repo, head:null → ok (no commits yet)", () => {
    const r = mapGitProbe({ isRepo: true, gitWorks: true, head: null });
    expect(r.status).toBe("ok");
    expect(r.detail).toBe("git repo present, no commits yet");
  });

  test("repo, head:sha → ok with short sha", () => {
    const r = mapGitProbe({ isRepo: true, gitWorks: true, head: "0123456789abcdef" });
    expect(r.status).toBe("ok");
    expect(r.detail).toBe("git repo present, HEAD 0123456");
  });
});

describe("mapMcpProbe", () => {
  test("null → fail", () => {
    const r = mapMcpProbe(null);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("not resolvable");
    expect(r.remediation).not.toContain("npm i -g");
  });

  test("a path → ok", () => {
    const r = mapMcpProbe("/abs/path/to/dist/index.js");
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("mcp-server entry resolves");
  });
});

describe("compareVersions", () => {
  test("equal versions → info", () => {
    const r = compareVersions({ cliVersion: "0.4.0", mcpVersion: "0.4.0", nodeVersion: "v20.0.0" });
    expect(r.status).toBe("info");
    expect(r.detail).toContain("node v20.0.0");
  });

  test("differing versions → warn (skew)", () => {
    const r = compareVersions({ cliVersion: "0.4.0", mcpVersion: "0.3.0", nodeVersion: "v20.0.0" });
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("version skew");
    expect(r.remediation).toContain("match");
  });
});

describe("scanSyncArtifacts", () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  test("`.ledger/config 2.json` → warn listing it", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-sync-"));
    mkdirSync(join(dir, ".ledger"), { recursive: true });
    writeFileSync(join(dir, ".ledger", "config 2.json"), "{}");
    const r = scanSyncArtifacts(dir);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain(".ledger/config 2.json");
    expect(r.remediation).toContain("cloud-sync duplicates");
  });

  test("duplicated git ref under `.git/refs/` (recursive) → warn", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-sync-"));
    mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(dir, ".git", "refs", "heads", "main 2"), "deadbeef");
    const r = scanSyncArtifacts(dir);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain(".git/refs/heads/main 2");
  });

  test("clean `.ledger/` → ok", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-sync-"));
    mkdirSync(join(dir, ".ledger"), { recursive: true });
    writeFileSync(join(dir, ".ledger", "config.json"), "{}");
    const r = scanSyncArtifacts(dir);
    expect(r.status).toBe("ok");
    expect(r.detail).toBe("no cloud-sync duplicate artifacts found");
  });

  test("`Page 2.md` at vault root is NOT flagged (scope excludes note space)", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-sync-"));
    mkdirSync(join(dir, ".ledger"), { recursive: true });
    writeFileSync(join(dir, "Page 2.md"), "# note");
    const r = scanSyncArtifacts(dir);
    expect(r.status).toBe("ok");
  });

  test("nonexistent `.ledger/` and `.git/` → ok (dirs absent)", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-sync-"));
    const r = scanSyncArtifacts(dir);
    expect(r.status).toBe("ok");
  });
});

describe("runDoctor — vault-independent checks run unconditionally", () => {
  test("uninitialized dir still runs git/mcp/versions/sync-artifacts (not skipped)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vl-empty-"));
    try {
      const { checks } = await runDoctor(dir, { json: false, strict: false }, {});
      for (const name of ["git", "mcp", "versions", "sync-artifacts"]) {
        const c = checks.find((x) => x.name === name)!;
        expect(c).toBeDefined();
        expect(c.status).not.toBe("skipped");
      }
      // mcp + versions resolve from the installed workspace regardless of vault state
      expect(checks.find((c) => c.name === "mcp")!.status).toBe("ok");
      expect(["info", "warn"]).toContain(checks.find((c) => c.name === "versions")!.status);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("uninitialized dir: all five vault-dependent checks cascade-skip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vl-empty-"));
    try {
      const { checks } = await runDoctor(dir, { json: false, strict: false }, {});
      for (const name of ["zone-integrity", "journal", "lock", "bridge", "plugin"]) {
        expect(checks.find((c) => c.name === name)!.status).toBe("skipped");
      }
      // interim placeholder gone: journal is a real cascade skip, not a placeholder
      expect(checks.find((c) => c.name === "journal")!.detail).not.toContain("placeholder");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("checkZoneIntegrity", () => {
  test("Private folder present at init time is excluded → ok", async () => {
    const vaultDir = mkdtempSync(join(tmpdir(), "vl-zone-"));
    const homeDir = mkdtempSync(join(tmpdir(), "vl-home-"));
    try {
      // Create the Private folder BEFORE init so scanVault bakes `**/Private/**`
      // into the written manifest.
      mkdirSync(join(vaultDir, "Agent", "Memory", "Private"), { recursive: true });
      await initCommand(vaultDir, { confirm: true, rand: () => "test1234", out: () => {} });
      const env = { HOME: homeDir } as NodeJS.ProcessEnv;
      const { checks } = await runDoctor(vaultDir, { json: false, strict: false }, { env });
      const zi = checks.find((c) => c.name === "zone-integrity")!;
      expect(zi.status).toBe("ok");
      expect(zi.detail).toContain("all excluded");
      expect(zi.detail).toContain(".ledger/** excluded");
    } finally {
      rmSync(vaultDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("a Private folder NOT covered by excluded globs → fail", () => {
    const dir = mkdtempSync(join(tmpdir(), "vl-zone-"));
    try {
      mkdirSync(join(dir, "Private"), { recursive: true });
      // Hand-built manifest whose excluded does NOT cover the Private folder.
      const manifest = PermissionsManifest.parse({
        zones: { trusted: ["**"], agent: [], scratch: [], excluded: [".obsidian/**"] },
      });
      const r = checkZoneIntegrity(dir, manifest);
      expect(r.status).toBe("fail");
      expect(r.detail).toContain("Private");
      expect(r.remediation).toContain("permissions.yaml");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("no Private folders present → ok with the 'no Private' wording", () => {
    const dir = mkdtempSync(join(tmpdir(), "vl-zone-"));
    try {
      const manifest = PermissionsManifest.parse({});
      const r = checkZoneIntegrity(dir, manifest);
      expect(r.status).toBe("ok");
      expect(r.detail).toContain("no Private folders present");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("mapJournalProbe", () => {
  test("absent → warn (reindex)", () => {
    const r = mapJournalProbe({ status: "absent" }, false);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("not built yet");
    expect(r.remediation).toContain("ledger reindex");
  });

  test("ok → ok with count", () => {
    const r = mapJournalProbe({ status: "ok", count: 42 }, false);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("42 memories indexed");
  });

  test("unreadable + live writer → info (busy)", () => {
    const r = mapJournalProbe({ status: "unreadable", error: "torn copy" }, true);
    expect(r.status).toBe("info");
    expect(r.detail).toContain("busy");
  });

  test("unreadable + no live writer → warn", () => {
    const r = mapJournalProbe({ status: "unreadable", error: "corrupt" }, false);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("unreadable");
    expect(r.remediation).toContain("ledger reindex");
  });
});

describe("checkLock", () => {
  let home: string | undefined;
  afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); home = undefined; });

  const env = (): NodeJS.ProcessEnv => ({ HOME: home! }) as NodeJS.ProcessEnv;

  test("absent lock → ok, live false", () => {
    home = mkdtempSync(join(tmpdir(), "vl-home-"));
    const { result, live } = checkLock("test1234", env(), () => 1000);
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("no mutation lock");
    expect(live).toBe(false);
  });

  test("fresh lock → ok, live true", () => {
    home = mkdtempSync(join(tmpdir(), "vl-home-"));
    const lockPath = join(vaultLockDir("test1234", env()), "vault.lock");
    mkdirSync(lockPath, { recursive: true });
    const mtimeMs = statSync(lockPath).mtimeMs;
    const { result, live } = checkLock("test1234", env(), () => mtimeMs + 1000);
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("writer holds the mutation lock");
    expect(live).toBe(true);
  });

  test("stale lock → warn, live false, remediation names the path", () => {
    home = mkdtempSync(join(tmpdir(), "vl-home-"));
    const lockPath = join(vaultLockDir("test1234", env()), "vault.lock");
    mkdirSync(lockPath, { recursive: true });
    const mtimeMs = statSync(lockPath).mtimeMs;
    const { result, live } = checkLock("test1234", env(), () => mtimeMs + LOCK_CONFIG.stale + 5000);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("stale mutation lock");
    expect(result.remediation).toContain(lockPath);
    expect(live).toBe(false);
  });
});

describe("runDoctor — bridge check", () => {
  let v: TestVault | undefined;
  afterEach(() => { v?.cleanup(); v = undefined; });

  async function bridgeCheck(bridge: unknown | null): Promise<string> {
    v = await makeInitializedVault();
    const dir = vaultLockDir("vault_test1234", v.deps.env);
    mkdirSync(dir, { recursive: true });
    if (bridge !== null) writeFileSync(join(dir, "bridge.json"), JSON.stringify(bridge));
    const { checks } = await runDoctor(v.vaultDir, { json: false, strict: false }, { env: v.deps.env });
    return checks.find((c) => c.name === "bridge")!.status;
  }

  test("alive pid → ok", async () => {
    v = await makeInitializedVault();
    const dir = vaultLockDir("vault_test1234", v.deps.env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "bridge.json"),
      JSON.stringify({ pid: process.pid, port: 51234, token: "t", startedAt: "x" }),
    );
    const { checks } = await runDoctor(v.vaultDir, { json: false, strict: false }, { env: v.deps.env });
    const b = checks.find((c) => c.name === "bridge")!;
    expect(b.status).toBe("ok");
    expect(b.detail).toContain("port 51234");
    expect(b.detail).toContain(`pid ${process.pid}`);
  });

  test("surely-dead pid → warn", async () => {
    expect(await bridgeCheck({ pid: 2147483647, port: 51234, token: "t", startedAt: "x" })).toBe("warn");
  });

  test("absent bridge.json → info", async () => {
    expect(await bridgeCheck(null)).toBe("info");
  });

  test("present but corrupt bridge.json (cloud-sync truncation) → warn, not info", async () => {
    v = await makeInitializedVault();
    const dir = vaultLockDir("vault_test1234", v.deps.env);
    mkdirSync(dir, { recursive: true });
    // A truncated / non-JSON discovery file — must surface as corruption, not
    // be silently read as "bridge not running".
    writeFileSync(join(dir, "bridge.json"), '{"pid": 123, "por');
    const { checks } = await runDoctor(v.vaultDir, { json: false, strict: false }, { env: v.deps.env });
    const b = checks.find((c) => c.name === "bridge")!;
    expect(b.status).toBe("warn");
    expect(b.detail).toMatch(/malformed|corrupt/i);
  });

  test("present but wrong-shape bridge.json → warn", async () => {
    // Parses as JSON but lacks numeric pid/port.
    expect(await bridgeCheck({ foo: "bar" })).toBe("warn");
  });
});

describe("mapNativeProbe", () => {
  test("ok probe → ok", () => {
    expect(mapNativeProbe({ ok: true }).status).toBe("ok");
  });

  test("failed probe → fail with an approve-builds/rebuild remediation", () => {
    const r = mapNativeProbe({ ok: false, error: "Could not locate the bindings file.\n → /a\n → /b" });
    expect(r.status).toBe("fail");
    expect(r.remediation).toMatch(/approve-builds|npm rebuild better-sqlite3/);
    // detail collapses the multi-line dump to its first line.
    expect(r.detail.split("\n").length).toBe(1);
  });
});

describe("runDoctor — native-deps check (healthy install)", () => {
  let v: TestVault | undefined;
  afterEach(() => { v?.cleanup(); v = undefined; });

  test("a working better-sqlite3 install → native-deps ok, and it runs even on a garbage path", async () => {
    v = await makeInitializedVault();
    const { checks } = await runDoctor(v.vaultDir, { json: false, strict: false }, { env: v.deps.env });
    const nd = checks.find((c) => c.name === "native-deps")!;
    expect(nd.status).toBe("ok");

    // Vault-independent: present (not skipped) even on an uninitialized dir.
    const dir = mkdtempSync(join(tmpdir(), "vl-nd-"));
    try {
      const { checks: c2 } = await runDoctor(dir, { json: false, strict: false }, {});
      expect(c2.find((c) => c.name === "native-deps")!.status).toBe("ok");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("mapPluginFreshness", () => {
  test("null → info (not installed)", () => {
    const r = mapPluginFreshness(null);
    expect(r.status).toBe("info");
    expect(r.detail).toContain("not installed");
    expect(r.remediation).toContain("--install-plugin");
  });

  test("already → ok", () => {
    const r = mapPluginFreshness({ step: "plugin", state: "already", detail: "plugin v1 current" });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("current");
  });

  test("outdated → warn (carries the version-delta detail)", () => {
    const r = mapPluginFreshness({ step: "plugin", state: "outdated", detail: "v1 → v2" });
    expect(r.status).toBe("warn");
    expect(r.detail).toBe("v1 → v2");
    expect(r.remediation).toContain("--install-plugin");
  });
});

describe("nodeInEnginesRange", () => {
  test(">=20 with node v20/v22 → in range; v18 → out", () => {
    expect(nodeInEnginesRange("v20.11.0", ">=20")).toBe(true);
    expect(nodeInEnginesRange("v22.0.0", ">=20")).toBe(true);
    expect(nodeInEnginesRange("v18.19.0", ">=20")).toBe(false);
  });

  test("bounded range '>=18 <21' honors the upper bound", () => {
    expect(nodeInEnginesRange("v20.0.0", ">=18 <21")).toBe(true);
    expect(nodeInEnginesRange("v22.0.0", ">=18 <21")).toBe(false);
    expect(nodeInEnginesRange("v16.0.0", ">=18 <21")).toBe(false);
  });

  test("caret/bare forms treated as >= on the major", () => {
    expect(nodeInEnginesRange("v20.5.0", "^20")).toBe(true);
    expect(nodeInEnginesRange("v21.0.0", "20")).toBe(true);
  });

  test("unparseable range → null (unknown, folded into info by caller)", () => {
    expect(nodeInEnginesRange("v20.0.0", "garbage")).toBeNull();
    expect(nodeInEnginesRange("weird", ">=20")).toBeNull();
  });
});

describe("compareVersions — engines.node check (spec §3.10)", () => {
  test("node inside engines range → info line notes the range", () => {
    const r = compareVersions({ cliVersion: "0.4.0", mcpVersion: "0.4.0", nodeVersion: "v20.0.0", enginesNode: ">=20" });
    expect(r.status).toBe("info");
    expect(r.detail).toContain("engines >=20");
  });

  test("node outside engines range → warn", () => {
    const r = compareVersions({ cliVersion: "0.4.0", mcpVersion: "0.4.0", nodeVersion: "v18.0.0", enginesNode: ">=20" });
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("outside supported range >=20");
    expect(r.remediation).toContain(">=20");
  });

  test("no enginesNode → unchanged info (backward compatible)", () => {
    const r = compareVersions({ cliVersion: "0.4.0", mcpVersion: "0.4.0", nodeVersion: "v20.0.0" });
    expect(r.status).toBe("info");
    expect(r.detail).not.toContain("engines");
  });
});

describe("runDoctor — crash-safety on confused / broken inputs", () => {
  test("a nonexistent vaultDir returns a tidy result (no throw): config fail, git graceful fail, exit 1", async () => {
    let result: Awaited<ReturnType<typeof runDoctor>> | undefined;
    await expect(
      (async () => { result = await runDoctor("/no/such/vault/path-xyz", { json: false, strict: false }, {}); })(),
    ).resolves.toBeUndefined();
    const { checks, exitCode } = result!;
    expect(checks.find((c) => c.name === "config")!.status).toBe("fail");
    expect(exitCode).toBe(1);
    const git = checks.find((c) => c.name === "git")!;
    expect(git.status).toBe("fail");
    // A GRACEFUL fail (probeGitRepo's "not a repo"), NOT a swallowed crash.
    expect(git.detail).not.toContain("check errored");
    expect(git.detail).toContain("not a git repo");
    // versions never crashes the command — it's a real result, not a throw.
    expect(["info", "warn"]).toContain(checks.find((c) => c.name === "versions")!.status);
  });

  test("runDoctor never throws even when the dir is a file, not a directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vl-file-"));
    const asFile = join(dir, "not-a-dir");
    writeFileSync(asFile, "i am a file");
    try {
      await expect(
        runDoctor(asFile, { json: false, strict: false }, {}),
      ).resolves.toBeDefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("runDoctor — corrupt permissions.yaml (config ok, manifest unparseable)", () => {
  let v: TestVault | undefined;
  afterEach(() => { v?.cleanup(); v = undefined; });

  test("permissions fail AND zone-integrity skipped with the DISTINCT corrupt-manifest message", async () => {
    v = await makeInitializedVault();
    // Valid YAML that violates the manifest schema (version must be the
    // literal 1; zones must be an object), while config.json stays valid.
    writeFileSync(permissionsPath(v.vaultDir), "version: 2\nzones: not-an-object\n");
    const { checks } = await runDoctor(v.vaultDir, { json: false, strict: false }, { env: v.deps.env });
    expect(checks.find((c) => c.name === "config")!.status).toBe("ok");
    expect(checks.find((c) => c.name === "permissions")!.status).toBe("fail");
    const zi = checks.find((c) => c.name === "zone-integrity")!;
    expect(zi.status).toBe("skipped");
    expect(zi.detail).toContain("permissions.yaml did not parse");
    expect(zi.detail).not.toContain("no initialized vault");
  });
});
