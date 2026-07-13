#!/usr/bin/env node
// Pre-publish pack-and-inspect verification (WU-4).
//
// Packs the 4 publishable workspace packages (core, server, mcp-server, cli —
// NOT the private obsidian-plugin) into a scratch dir with
// `pnpm -r --filter '!@vaultledger/obsidian-plugin' pack`, then inspects each
// tarball's actual contents (`tar -tzf`) and packed `package.json` to prove
// what a real `pnpm -r publish` would ship. This is the mechanical check that
// runs *before* the irreversible publish (WU-4 step 2) — see
// docs/design/specs/2026-07-13-v040-npm-release-runbook.md.
//
// Plain Node, no deps. Runnable as: node scripts/verify-publish.mjs
//
// Checks per tarball:
//   - present: dist/ with at least one .js and one .d.ts (maps expected but
//     not required, since the base tsconfig emits sourceMap+declarationMap);
//     bin/<name>.mjs for packages that declare a bin; LICENSE; README.md;
//     package.json.
//   - absent: src/, test/, tsconfig*, *.tsbuildinfo, any " 2."-pattern
//     (iCloud-duplicate) file, any .env* file.
//   - every @vaultledger/* range in the packed package.json reads exactly
//     "0.4.0" (the workspace:* rewrite happened; no literal "workspace:"
//     remains).
//   - independently: @vaultledger/obsidian-plugin does NOT appear in the
//     packed package.json's "dependencies" (it MAY appear in
//     devDependencies — harmless, registry installs never install a
//     dependency's devDeps). This is checked separately from the "reads
//     0.4.0" check because a re-added plugin dependency would ALSO read
//     0.4.0 after the rewrite and would silently pass that check alone.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// name -> expected bin entry filename under bin/, or undefined if no bin.
const PACKAGES = {
  "@vaultledger/core": undefined,
  "@vaultledger/server": undefined,
  "@vaultledger/mcp-server": "vaultledger-mcp.mjs",
  "@vaultledger/cli": "ledger.mjs",
};

const ICLOUD_DUPE_RE = / [0-9]+(\.|$)/;

function fail(pkgName, results, message) {
  results.push({ ok: false, message });
}

function pass(pkgName, results, message) {
  results.push({ ok: true, message });
}

/** List tarball entries via `tar -tzf`, returned as relative paths (no leading "package/"). */
function listTarballEntries(tarballPath) {
  const out = execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8" });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((entry) => (entry.startsWith("package/") ? entry.slice("package/".length) : entry));
}

/** Extract a single file's contents from the tarball, as a UTF-8 string. */
function extractFile(tarballPath, entryPath) {
  return execFileSync(
    "tar",
    ["-xzf", tarballPath, "-O", `package/${entryPath}`],
    { encoding: "utf8" },
  );
}

function verifyPackage(pkgName, binName, tarballPath, results) {
  const entries = listTarballEntries(tarballPath);

  // --- present ---
  const distEntries = entries.filter((e) => e.startsWith("dist/"));
  if (distEntries.length === 0) {
    fail(pkgName, results, "missing dist/ entirely");
  } else {
    pass(pkgName, results, `dist/ present (${distEntries.length} files)`);
  }
  const hasJs = distEntries.some((e) => e.endsWith(".js"));
  const hasDts = distEntries.some((e) => e.endsWith(".d.ts"));
  if (!hasJs) fail(pkgName, results, "no .js file under dist/");
  else pass(pkgName, results, "dist/*.js present");
  if (!hasDts) fail(pkgName, results, "no .d.ts file under dist/");
  else pass(pkgName, results, "dist/*.d.ts present");
  const hasJsMap = distEntries.some((e) => e.endsWith(".js.map"));
  const hasDtsMap = distEntries.some((e) => e.endsWith(".d.ts.map"));
  if (!hasJsMap || !hasDtsMap) {
    pass(
      pkgName,
      results,
      `note: expected sourceMap/declarationMap but found js.map=${hasJsMap} d.ts.map=${hasDtsMap} (advisory, not a failure)`,
    );
  } else {
    pass(pkgName, results, "dist/*.js.map + *.d.ts.map present");
  }

  if (binName) {
    const binPath = `bin/${binName}`;
    if (!entries.includes(binPath)) {
      fail(pkgName, results, `declares a bin but ${binPath} is missing from tarball`);
    } else {
      pass(pkgName, results, `${binPath} present`);
    }
  }

  if (!entries.includes("LICENSE")) {
    fail(pkgName, results, "LICENSE missing from tarball");
  } else {
    pass(pkgName, results, "LICENSE present");
  }
  if (!entries.includes("README.md")) {
    fail(pkgName, results, "README.md missing from tarball");
  } else {
    pass(pkgName, results, "README.md present");
  }
  if (!entries.includes("package.json")) {
    fail(pkgName, results, "package.json missing from tarball");
  } else {
    pass(pkgName, results, "package.json present");
  }

  // --- absent ---
  const forbiddenDirPrefixes = ["src/", "test/"];
  const forbiddenDirHits = entries.filter((e) =>
    forbiddenDirPrefixes.some((prefix) => e.startsWith(prefix)),
  );
  if (forbiddenDirHits.length > 0) {
    fail(pkgName, results, `forbidden src/test entries present: ${forbiddenDirHits.join(", ")}`);
  } else {
    pass(pkgName, results, "no src/ or test/ entries");
  }

  const tsconfigHits = entries.filter((e) => {
    const base = e.split("/").pop() ?? e;
    return base.startsWith("tsconfig") || base.endsWith(".tsbuildinfo");
  });
  if (tsconfigHits.length > 0) {
    fail(pkgName, results, `tsconfig/tsbuildinfo entries present: ${tsconfigHits.join(", ")}`);
  } else {
    pass(pkgName, results, "no tsconfig*/*.tsbuildinfo entries");
  }

  const icloudDupeHits = entries.filter((e) => ICLOUD_DUPE_RE.test(e.split("/").pop() ?? e));
  if (icloudDupeHits.length > 0) {
    fail(pkgName, results, `iCloud-duplicate-pattern entries present: ${icloudDupeHits.join(", ")}`);
  } else {
    pass(pkgName, results, 'no " 2."-pattern (iCloud-duplicate) entries');
  }

  const envHits = entries.filter((e) => {
    const base = e.split("/").pop() ?? e;
    return base.startsWith(".env");
  });
  if (envHits.length > 0) {
    fail(pkgName, results, `.env* entries present: ${envHits.join(", ")}`);
  } else {
    pass(pkgName, results, "no .env* entries");
  }

  // --- packed package.json: workspace:* rewrite + no private plugin dep ---
  let packedPkg;
  try {
    const raw = extractFile(tarballPath, "package.json");
    packedPkg = JSON.parse(raw);
  } catch (err) {
    fail(
      pkgName,
      results,
      `failed to extract/parse packed package.json: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const depFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  let sawUnrewrittenWorkspace = false;
  for (const field of depFields) {
    const deps = packedPkg[field];
    if (!deps || typeof deps !== "object") continue;
    for (const [depName, range] of Object.entries(deps)) {
      if (!depName.startsWith("@vaultledger/")) continue;
      if (typeof range !== "string" || range.includes("workspace:")) {
        sawUnrewrittenWorkspace = true;
        fail(
          pkgName,
          results,
          `${field}.${depName} still reads "${range}" — workspace:* rewrite did not happen`,
        );
      } else if (range !== "0.4.0") {
        fail(
          pkgName,
          results,
          `${field}.${depName} reads "${range}", expected exactly "0.4.0"`,
        );
      }
    }
  }
  if (!sawUnrewrittenWorkspace) {
    pass(pkgName, results, "all @vaultledger/* ranges rewritten to 0.4.0 (no literal workspace:)");
  }

  // Independent check (WU-1 regression guard): obsidian-plugin must never
  // appear in packed `dependencies`, even though it WOULD read a valid
  // "0.4.0" after rewrite and so would pass the check above alone.
  const runtimeDeps = packedPkg.dependencies;
  if (runtimeDeps && typeof runtimeDeps === "object" && "@vaultledger/obsidian-plugin" in runtimeDeps) {
    fail(
      pkgName,
      results,
      "@vaultledger/obsidian-plugin appears in packed dependencies (private/unpublished package would 404 for consumers) — this is the WU-1 regression guard",
    );
  } else {
    pass(pkgName, results, "@vaultledger/obsidian-plugin absent from packed dependencies");
  }
}

function main() {
  const scratchDir = mkdtempSync(join(tmpdir(), "vl-verify-publish-"));
  let overallOk = true;
  const summaries = [];

  try {
    console.log(`verify-publish: packing into scratch dir ${scratchDir}`);
    try {
      // Capture rather than inherit: pnpm's own `pack` output re-lists every
      // tarball's contents, which just duplicates our own per-package
      // summary below. On success we print one line; on failure we dump
      // pnpm's full stdout/stderr for diagnosis.
      execFileSync(
        "pnpm",
        [
          "-r",
          "--filter",
          "!@vaultledger/obsidian-plugin",
          "pack",
          "--pack-destination",
          scratchDir,
        ],
        { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
      );
      console.log("verify-publish: `pnpm -r pack` completed");
    } catch (err) {
      console.error("verify-publish: FAIL — `pnpm -r pack` failed");
      if (err && typeof err === "object") {
        if (err.stdout) console.error(err.stdout.toString());
        if (err.stderr) console.error(err.stderr.toString());
      }
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }

    for (const [pkgName, binName] of Object.entries(PACKAGES)) {
      const shortName = pkgName.replace("@vaultledger/", "");
      const results = [];

      // pnpm names tarballs like vaultledger-core-0.4.0.tgz.
      const expectedPrefix = `vaultledger-${shortName}-`;
      const candidates = readTarballCandidates(scratchDir, expectedPrefix);
      if (candidates.length !== 1) {
        results.push({
          ok: false,
          message: `expected exactly 1 tarball matching ${expectedPrefix}*.tgz in scratch dir, found ${candidates.length}: ${candidates.join(", ")}`,
        });
      } else {
        verifyPackage(pkgName, binName, join(scratchDir, candidates[0]), results);
      }

      const pkgOk = results.every((r) => r.ok);
      overallOk = overallOk && pkgOk;
      summaries.push({ pkgName, pkgOk, results });
    }

    console.log("\n=== verify-publish summary ===");
    for (const { pkgName, pkgOk, results } of summaries) {
      console.log(`\n${pkgOk ? "PASS" : "FAIL"} — ${pkgName}`);
      for (const r of results) {
        console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.message}`);
      }
    }
    console.log(`\n${overallOk ? "ALL PACKAGES PASS" : "ONE OR MORE PACKAGES FAILED"}`);

    process.exitCode = overallOk ? 0 : 1;
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

function readTarballCandidates(scratchDir, expectedPrefix) {
  return readdirSync(scratchDir).filter(
    (f) => f.startsWith(expectedPrefix) && f.endsWith(".tgz"),
  );
}

main();
