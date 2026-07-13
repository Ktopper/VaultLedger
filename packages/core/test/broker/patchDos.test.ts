import { describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_PATCH = join(__dirname, "..", "..", "dist", "broker", "patch.js");
const distBuilt = existsSync(DIST_PATCH);

// Real wall-clock budget for the child to either finish cleanly or be killed.
// diff@7.0.0's bug is a synchronous, memory-leaking `while` loop that never
// yields to the event loop -- it cannot be bounded by vi fake timers (there is
// no tick to advance), so this MUST be a real child process with a real OS
// kill after a real timeout.
const KILL_TIMEOUT_MS = 8_000;

interface ChildOutcome {
  /** true if the child crashed (non-zero exit / killed by signal, including
   * our own SIGKILL after the wall-clock timeout) rather than exiting 0. */
  crashedOrTimedOut: boolean;
  detail: string;
}

/**
 * VL-SEC-S4-01: diff@<8.0.3's `parsePatch` (CVE-2026-24001) infinite-loops on
 * a "---"/"+++" header line containing an embedded `\r` not at the very end
 * -- an 8-byte `patch` string ("--- a\rb\n") is enough. `parseIndex()`'s
 * metadata-scan loop breaks out with its cursor unchanged, so the caller's
 * `while (i < diffstr.length) parseIndex();` calls it again on the identical
 * input forever, pushing a new object onto the result array every iteration
 * -- an OOM crash, not just a CPU spin.
 *
 * Spawns the REAL COMPILED broker entry point (dist/broker/patch.js, what
 * broker.ts's revise/propose_edit path actually calls, and what
 * memory_revise's unbounded `patch` argument reaches directly for any
 * scratch/working memory -- no queue, no human step) under a real memory cap
 * so a still-vulnerable `diff` crashes fast instead of exhausting the host,
 * and under a real wall-clock kill in case it hangs without OOMing on a
 * particular platform/heap-cap combination.
 *
 * Because the import specifier is an absolute `file://` URL (not a bare
 * "diff" specifier), the child script's own location doesn't matter for
 * module resolution -- it always resolves the exact `diff` version installed
 * under packages/core/node_modules, whatever that currently is. This is
 * deliberate: bumping `diff` alone (no rebuild of patch.ts) is sufficient to
 * flip this test from RED to GREEN, since dist/broker/patch.js's own emitted
 * `import ... from "diff"` is resolved at runtime, not bundled.
 *
 * Guarded on the built dist like bin.launcher.smoke.test.ts's DIST_ENTRY
 * check -- this proves the actual shipped artifact, not a reimplementation.
 */
async function runHostilePatchChild(): Promise<ChildOutcome> {
  const workDir = mkdtempSync(join(tmpdir(), "vl-s4-01-child-"));
  try {
    const scriptPath = join(workDir, "child.mjs");
    const patchModuleUrl = pathToFileURL(DIST_PATCH).href;
    writeFileSync(
      scriptPath,
      [
        `import { applyPatch } from ${JSON.stringify(patchModuleUrl)};`,
        `const original = "some existing note content\\n";`,
        `const patchText = "--- a\\rb\\n";`,
        // A fixed `diff` correctly REJECTS this hostile patch synchronously
        // (a normal thrown BrokerError) instead of hanging/OOM-crashing --
        // that thrown-and-caught outcome is SAFE and must exit 0, so the
        // test's exit-code/signal check only ever sees a real crash (OOM
        // SIGABRT) or our own SIGKILL-after-timeout as a failure.
        `try {`,
        `  applyPatch(original, patchText, 0.5);`,
        `} catch (e) {`,
        `  process.stdout.write("REJECTED: " + (e && e.message) + "\\n");`,
        `}`,
        `process.stdout.write("FINISHED\\n");`,
      ].join("\n"),
      "utf8",
    );

    return await new Promise<ChildOutcome>((resolve) => {
      const child = spawn(process.execPath, ["--max-old-space-size=256", scriptPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        resolve({
          crashedOrTimedOut: true,
          detail:
            `child was still running after ${KILL_TIMEOUT_MS}ms wall-clock budget and was ` +
            `SIGKILLed (hung); stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
        });
      }, KILL_TIMEOUT_MS);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          crashedOrTimedOut: code !== 0 || signal !== null,
          detail: `exit code=${String(code)} signal=${String(signal)} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr).slice(0, 500)}`,
        });
      });
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

describe.skipIf(!distBuilt)("applyPatch (VL-SEC-S4-01 diff parsePatch DoS)", () => {
  test(
    "an 8-byte hostile patch with an embedded \\r header does not hang or crash the process",
    async () => {
      const outcome = await runHostilePatchChild();
      expect(outcome.crashedOrTimedOut, outcome.detail).toBe(false);
    },
    KILL_TIMEOUT_MS + 5_000,
  );
});

test.skipIf(distBuilt)(
  "patchDos test skipped: dist/broker/patch.js not built (run `pnpm build` first)",
  () => {
    expect(distBuilt).toBe(false);
  },
);
