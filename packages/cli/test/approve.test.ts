import { afterEach, describe, expect, test } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPatch } from "diff";
import { hashFile } from "@vaultledger/core";
import { loadContext } from "../src/context.js";
import { approveCommand } from "../src/commands/approve.js";
import { makeInitializedVault, type TestVault } from "./helpers.js";

let vault: TestVault;

afterEach(() => {
  vault?.cleanup();
});

async function seedProposeEdit(vault: TestVault): Promise<{ approvalId: string; after: string; relPath: string }> {
  const relPath = "hello.md";
  const abs = join(vault.vaultDir, relPath);
  // Enough surrounding lines that a one-line change stays under the default
  // 50% patch-size threshold (a single-line file would trip PATCH_TOO_LARGE).
  const before = "Line one\nLine two\nHello\nLine four\nLine five\n";
  const after = "Line one\nLine two\nHello world\nLine four\nLine five\n";
  writeFileSync(abs, before, "utf8");

  const ctx = await loadContext(vault.vaultDir, vault.deps);
  const patch = createPatch(relPath, before, after);
  const result = await ctx.broker.apply({
    op: "propose_edit",
    path: relPath,
    expected_hash: hashFile(abs),
    patch,
    reason: "propose a wording change",
    session: "s1",
  });
  ctx.db.close();

  if (!("queued" in result) || !result.queued) {
    throw new Error("expected propose_edit to queue an approval");
  }
  return { approvalId: result.approvalId, after, relPath };
}

describe("approveCommand", () => {
  test("no id: lists pending approvals with a rendered diff", async () => {
    vault = await makeInitializedVault();
    const { approvalId } = await seedProposeEdit(vault);

    const messages: string[] = [];
    const result = await approveCommand(vault.vaultDir, { out: (s) => messages.push(s) }, vault.deps);

    expect(Array.isArray(result)).toBe(true);
    expect((result as { id: string }[]).map((a) => a.id)).toContain(approvalId);
    const rendered = messages.join("\n");
    expect(rendered).toContain(approvalId);
    expect(rendered).toContain("-Hello");
    expect(rendered).toContain("+Hello world");
  });

  test("id given: applies the held propose_edit (file changes)", async () => {
    vault = await makeInitializedVault();
    const { approvalId, after, relPath } = await seedProposeEdit(vault);

    const messages: string[] = [];
    const result = await approveCommand(
      vault.vaultDir,
      { id: approvalId, out: (s) => messages.push(s) },
      vault.deps,
    );

    expect(result).toEqual({ applied: true });
    const content = readFileSync(join(vault.vaultDir, relPath), "utf8");
    expect(content).toBe(after);
  });

  test("id + reject: rejects without applying", async () => {
    vault = await makeInitializedVault();
    const { approvalId, relPath } = await seedProposeEdit(vault);
    const before = readFileSync(join(vault.vaultDir, relPath), "utf8");

    const result = await approveCommand(vault.vaultDir, { id: approvalId, reject: true }, vault.deps);

    expect(result).toEqual({ rejected: true });
    const after = readFileSync(join(vault.vaultDir, relPath), "utf8");
    expect(after).toBe(before);
  });

  test("unknown id: reports NOT_FOUND without throwing", async () => {
    vault = await makeInitializedVault();

    const messages: string[] = [];
    const result = await approveCommand(
      vault.vaultDir,
      { id: "apr_doesnotexist", out: (s) => messages.push(s) },
      vault.deps,
    );

    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(messages.join("\n")).toContain("NOT_FOUND");
  });

  test("stale approval: file changed after queueing -> returns stale, file untouched", async () => {
    vault = await makeInitializedVault();
    const { approvalId, relPath } = await seedProposeEdit(vault);

    // Mutate the target file out from under the queued propose_edit so its
    // expected_hash no longer matches on-disk bytes.
    const abs = join(vault.vaultDir, relPath);
    const drifted = "Line one\nLine two\nDrifted\nLine four\nLine five\n";
    writeFileSync(abs, drifted, "utf8");

    const messages: string[] = [];
    const result = await approveCommand(
      vault.vaultDir,
      { id: approvalId, out: (s) => messages.push(s) },
      vault.deps,
    );

    expect(result).toEqual({ stale: true });
    expect(messages.join("\n")).toContain("stale");
    // The proposed edit was NOT applied; the file keeps the drifted content.
    expect(readFileSync(abs, "utf8")).toBe(drifted);
  });
});
