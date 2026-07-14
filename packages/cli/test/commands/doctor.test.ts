import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeInitializedVault, type TestVault } from "../helpers.js";
import {
  runDoctor,
  mapGitProbe,
  mapMcpProbe,
  compareVersions,
  scanSyncArtifacts,
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
});
