#!/usr/bin/env node
// prepack build-integrity guard (WU-3).
//
// Runs as each publishable package's `prepack` script (pnpm/npm invoke
// `prepack` on both `pack` and `publish`), with cwd set to the package
// directory. A hand-run publish is the classic way a stale or missing build
// ships a broken tarball; this makes that structurally impossible by
// asserting, from the package's own package.json:
//
//   1. every published entry target (main, types, and every `exports`
//      subpath's target, in all its string / condition-object forms)
//      exists on disk;
//   2. every `bin` target exists;
//   3. no iCloud-duplicate junk (e.g. "index 2.js", "ledger 2.mjs") sits
//      under dist/ or bin/;
//   4. the build isn't stale — dist's main entry is not older than the
//      newest file under src/ (skipped if there is no src/ dir).
//
// Plain Node, no deps, no build step of its own.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const cwd = process.cwd();

function fail(message) {
  console.error(`prepack-check: FAIL — ${message}`);
  process.exit(1);
}

const pkgPath = join(cwd, "package.json");
if (!existsSync(pkgPath)) {
  fail(`no package.json found in ${cwd}`);
}

let pkg;
try {
  pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
} catch (err) {
  fail(`failed to parse ${pkgPath}: ${err instanceof Error ? err.message : String(err)}`);
}

/**
 * Collect every string path found in an `exports`-style value, recursing
 * through condition-object forms ({ import, require, types, default, ... }
 * and any further nesting). Non-string, non-object values are ignored.
 */
function collectExportTargets(value, acc) {
  if (typeof value === "string") {
    acc.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectExportTargets(item, acc);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectExportTargets(item, acc);
  }
}

const entryTargets = [];
if (typeof pkg.main === "string") entryTargets.push(pkg.main);
if (typeof pkg.types === "string") entryTargets.push(pkg.types);
if (pkg.exports && typeof pkg.exports === "object") {
  for (const value of Object.values(pkg.exports)) {
    collectExportTargets(value, entryTargets);
  }
}

// 1. Every published entry target must exist.
const missingEntries = entryTargets.filter((t) => !existsSync(resolve(cwd, t)));
if (missingEntries.length > 0) {
  fail(`missing published entry target(s): ${missingEntries.join(", ")}`);
}

// 2. Every bin target must exist.
if (pkg.bin) {
  const binTargets =
    typeof pkg.bin === "string"
      ? [pkg.bin]
      : Object.values(pkg.bin).filter((v) => typeof v === "string");
  const missingBin = binTargets.filter((t) => !existsSync(resolve(cwd, t)));
  if (missingBin.length > 0) {
    fail(`missing bin target(s): ${missingBin.join(", ")}`);
  }
}

/** Recursively collect every file path under `dir` (absolute paths). */
function walk(dir, out) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

// 3. No iCloud-duplicate junk under dist/ or bin/ (e.g. "index 2.js").
const DUPE_RE = / [0-9]+(\.|$)/;
const scannedFiles = [];
for (const d of ["dist", "bin"]) walk(join(cwd, d), scannedFiles);
const dupes = scannedFiles.filter((f) => DUPE_RE.test(basename(f)));
if (dupes.length > 0) {
  fail(`found iCloud-duplicate file(s) under dist/ or bin/: ${dupes.join(", ")}`);
}

// 4. Staleness: dist's main entry must not be older than the newest src/ file.
const srcDir = join(cwd, "src");
if (existsSync(srcDir)) {
  const srcFiles = [];
  walk(srcDir, srcFiles);
  const mainTarget = typeof pkg.main === "string" ? pkg.main : entryTargets[0];
  if (srcFiles.length > 0 && mainTarget) {
    const mainAbs = resolve(cwd, mainTarget);
    if (existsSync(mainAbs)) {
      const newestSrcMtime = Math.max(...srcFiles.map((f) => statSync(f).mtimeMs));
      const mainMtime = statSync(mainAbs).mtimeMs;
      if (mainMtime < newestSrcMtime) {
        fail(
          `stale build: ${mainTarget} (mtime ${new Date(mainMtime).toISOString()}) is older ` +
            `than the newest file under src/ (mtime ${new Date(newestSrcMtime).toISOString()}) ` +
            `— rebuild before packing`,
        );
      }
    }
  }
}

console.log(`prepack-check: OK (${pkg.name ?? cwd})`);
process.exit(0);
