import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeInitializedVault, type TestVault } from "../helpers.js";
import { runDoctor } from "../../src/commands/doctor.js";

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
