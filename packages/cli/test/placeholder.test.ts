import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";

afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
});

test("run(['init', dir]) parses and completes without throwing (dry run)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vl-cli-smoke-"));
  writeFileSync(join(dir, "note.md"), "# Note\n");
  try {
    await expect(run(["init", dir])).resolves.toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("log --limit with a non-numeric value fails with a limit-specific error and non-zero exit, no throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vl-cli-limit-"));
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    // A bad --limit must be rejected at the command layer BEFORE the query
    // (and before loadContext), setting a non-zero exit code and printing a
    // message about the limit specifically — not sending NaN into the query.
    await expect(run(["log", dir, "--limit", "abc"])).resolves.toBeUndefined();
    expect(process.exitCode).not.toBe(0);
    const printed = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toMatch(/limit/i);
    expect(printed).not.toMatch(/VaultLedger vault/); // failed on the limit, not on load
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
