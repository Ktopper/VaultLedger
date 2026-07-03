import { expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";

test("run(['init', dir]) parses and completes without throwing (dry run)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vl-cli-smoke-"));
  writeFileSync(join(dir, "note.md"), "# Note\n");
  try {
    await expect(run(["init", dir])).resolves.toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
