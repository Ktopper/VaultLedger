import { describe, expect, test, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The script under test is a plain, build-free .mjs at the repo root's
// scripts/ dir. Repo root, relative to this test file
// (packages/core/test/prepackCheck.test.ts), is three levels up.
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "prepack-check.mjs");

interface FixtureOptions {
  /** package.json fields beyond the well-formed default. */
  pkg?: Record<string, unknown>;
  /** Skip writing dist/index.js (to simulate a missing build artifact). */
  omitMain?: boolean;
  /** Skip writing dist/index.d.ts. */
  omitTypes?: boolean;
  /** Extra files to plant, relative to the fixture root -> content. */
  extraFiles?: Record<string, string>;
}

function makeFixture(options: FixtureOptions = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "vl-prepack-check-"));
  mkdirSync(join(dir, "dist"), { recursive: true });

  const pkg = {
    name: "@vaultledger/fixture",
    version: "0.0.0",
    type: "module",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    ...options.pkg,
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));

  if (!options.omitMain) {
    writeFileSync(join(dir, "dist", "index.js"), "export {};\n");
  }
  if (!options.omitTypes) {
    writeFileSync(join(dir, "dist", "index.d.ts"), "export {};\n");
  }

  for (const [relPath, content] of Object.entries(options.extraFiles ?? {})) {
    const full = join(dir, relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }

  return dir;
}

function run(cwd: string) {
  return spawnSync(process.execPath, [SCRIPT], { cwd, encoding: "utf8" });
}

describe("prepack-check.mjs", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test("a well-formed fixture (main + types present, no dupes) exits 0", () => {
    dir = makeFixture();
    const result = run(dir);
    expect(result.status).toBe(0);
  });

  test("a planted iCloud-duplicate file (dist/index 2.js) exits non-zero", () => {
    dir = makeFixture({
      extraFiles: { "dist/index 2.js": "export {};\n" },
    });
    const result = run(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/dupl/i);
  });

  test("a planted iCloud-duplicate bin file (bin/x 2.mjs) exits non-zero", () => {
    dir = makeFixture({
      pkg: { bin: { x: "./bin/x.mjs" } },
      extraFiles: {
        "bin/x.mjs": "#!/usr/bin/env node\n",
        "bin/x 2.mjs": "#!/usr/bin/env node\n",
      },
    });
    const result = run(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/dupl/i);
  });

  test("a fixture missing dist/index.js exits non-zero", () => {
    dir = makeFixture({ omitMain: true });
    const result = run(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/missing/i);
  });

  test("a fixture missing dist/index.d.ts exits non-zero", () => {
    dir = makeFixture({ omitTypes: true });
    const result = run(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/missing/i);
  });

  test("resolves every exports subpath target, not just index.*", () => {
    dir = makeFixture({
      pkg: {
        exports: {
          ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
          "./config": { types: "./dist/config.d.ts", default: "./dist/config.js" },
        },
      },
      // dist/config.* deliberately NOT created -> should be caught.
    });
    const result = run(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/config/);
  });

  test("passes when every exports subpath target is present", () => {
    dir = makeFixture({
      pkg: {
        exports: {
          ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
          "./config": { types: "./dist/config.d.ts", default: "./dist/config.js" },
        },
      },
      extraFiles: {
        "dist/config.js": "export {};\n",
        "dist/config.d.ts": "export {};\n",
      },
    });
    const result = run(dir);
    expect(result.status).toBe(0);
  });

  test("missing bin target exits non-zero", () => {
    dir = makeFixture({ pkg: { bin: { ledger: "./bin/ledger.mjs" } } });
    const result = run(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/bin/i);
  });

  test("a build older than a src/ edit (stale build) exits non-zero", () => {
    dir = makeFixture();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "export {};\n");

    const now = Date.now();
    // dist/index.js built well before the src edit.
    utimesSync(join(dir, "dist", "index.js"), now / 1000, (now - 60_000) / 1000);
    utimesSync(join(dir, "dist", "index.d.ts"), now / 1000, (now - 60_000) / 1000);
    // src edited after the build.
    utimesSync(join(dir, "src", "index.ts"), now / 1000, now / 1000);

    const result = run(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/stale/i);
  });

  test("no src/ directory skips the staleness check (still exits 0)", () => {
    dir = makeFixture();
    const result = run(dir);
    expect(result.status).toBe(0);
  });
});
