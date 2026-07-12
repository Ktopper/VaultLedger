import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { defaultSteps } from "../../src/commands/setup.js";
import { resolveMcpServerEntry } from "../../src/setup/mcpConfig.js";
import type { SetupOptions } from "../../src/setup/types.js";

/**
 * Drives the REAL `defaultSteps().configureMcp` (not the fakes the
 * orchestrator test uses), capturing `out` and asserting each branch: the
 * print-by-default block, the two merge-refusal paths (which must NEVER
 * clobber the target), and the fresh-write path. Needs the mcp-server built
 * so `resolveMcpServerEntry()` returns an entry — guarded/skipped otherwise,
 * loud like the smoke test.
 */

const entry = resolveMcpServerEntry();
const distBuilt = entry !== null;

if (!distBuilt) {
  console.warn(
    "[defaultSteps.test] SKIPPED: mcp-server dist not built — run `pnpm -C packages/mcp-server build`",
  );
}

function baseOpts(overrides: Partial<SetupOptions> = {}): SetupOptions {
  return { yes: true, installPlugin: false, json: false, ...overrides };
}

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe.skipIf(!distBuilt)("defaultSteps().configureMcp (real entry resolution)", () => {
  const vault = "/some/vault";

  test("print-by-default (no writeMcp): out gets the block, state created, entry non-null", async () => {
    const steps = defaultSteps();
    const printed: string[] = [];
    const { result, entry: outEntry } = await steps.configureMcp(vault, baseOpts(), (s) => printed.push(s));

    expect(outEntry).not.toBeNull();
    expect(result).toMatchObject({ step: "mcp", state: "created" });
    expect(result.detail).toContain("--write-mcp");

    // The captured block is the pasteable config: names the entry path and the
    // vaultledger server key.
    expect(printed.length).toBe(1);
    const block = printed[0]!;
    expect(block).toContain(entry!);
    expect(block).toContain('"mcpServers"');
    expect(block).toContain('"vaultledger"');
  });

  test("merge-failure unparseable: block printed, state failed, target bytes UNCHANGED", async () => {
    dir = mkdtempSync(join(tmpdir(), "vl-defaultsteps-"));
    const target = join(dir, ".mcp.json");
    const original = "{ not json";
    writeFileSync(target, original, "utf8");

    const steps = defaultSteps();
    const printed: string[] = [];
    const { result } = await steps.configureMcp(vault, baseOpts({ writeMcp: target }), (s) => printed.push(s));

    expect(result).toMatchObject({ step: "mcp", state: "failed" });
    expect(result.detail).toContain("unparseable");
    // Block was printed for manual merge.
    expect(printed.some((s) => s.includes('"vaultledger"'))).toBe(true);
    // The unparseable file was NOT clobbered.
    expect(readFileSync(target, "utf8")).toBe(original);
  });

  test("merge-failure not-an-object: state failed, target bytes UNCHANGED", async () => {
    dir = mkdtempSync(join(tmpdir(), "vl-defaultsteps-"));
    const target = join(dir, ".mcp.json");
    const original = "[1,2,3]";
    writeFileSync(target, original, "utf8");

    const steps = defaultSteps();
    const printed: string[] = [];
    const { result } = await steps.configureMcp(vault, baseOpts({ writeMcp: target }), (s) => printed.push(s));

    expect(result).toMatchObject({ step: "mcp", state: "failed" });
    expect(result.detail).toContain("not-an-object");
    expect(printed.some((s) => s.includes('"vaultledger"'))).toBe(true);
    // The array-payload file was NOT clobbered.
    expect(readFileSync(target, "utf8")).toBe(original);
  });

  test("success write: absent target is created with our entry, state created", async () => {
    dir = mkdtempSync(join(tmpdir(), "vl-defaultsteps-"));
    const target = join(dir, ".mcp.json");
    expect(existsSync(target)).toBe(false);

    const steps = defaultSteps();
    const printed: string[] = [];
    const { result, entry: outEntry } = await steps.configureMcp(
      vault,
      baseOpts({ writeMcp: target }),
      (s) => printed.push(s),
    );

    expect(outEntry).toBe(entry);
    expect(result).toMatchObject({ step: "mcp", state: "created" });
    expect(result.detail).toContain(target);
    // On a successful write the block is NOT printed (only the refusal path prints).
    expect(printed).toEqual([]);

    expect(existsSync(target)).toBe(true);
    const written = JSON.parse(readFileSync(target, "utf8")) as {
      mcpServers: { vaultledger: { command: string; args: string[] } };
    };
    expect(written.mcpServers.vaultledger.command).toBe("node");
    expect(written.mcpServers.vaultledger.args).toEqual([entry, "--vault", vault]);
  });

  test("idempotent re-run: second call against the now-existing file reports already and does NOT rewrite it", async () => {
    dir = mkdtempSync(join(tmpdir(), "vl-defaultsteps-"));
    const target = join(dir, ".mcp.json");

    const steps = defaultSteps();
    const first = await steps.configureMcp(vault, baseOpts({ writeMcp: target }), () => {});
    expect(first.result).toMatchObject({ step: "mcp", state: "created" });

    const bytesBefore = readFileSync(target, "utf8");
    const mtimeBefore = statSync(target).mtimeMs;

    const printed: string[] = [];
    const second = await steps.configureMcp(vault, baseOpts({ writeMcp: target }), (s) => printed.push(s));

    expect(second.result).toMatchObject({ step: "mcp", state: "already" });
    expect(second.result.detail).toContain(target);
    // No rewrite: bytes AND mtime unchanged, no refusal block printed.
    expect(readFileSync(target, "utf8")).toBe(bytesBefore);
    expect(statSync(target).mtimeMs).toBe(mtimeBefore);
    expect(printed).toEqual([]);
  });
});

test.skipIf(distBuilt)("defaultSteps test skipped: mcp-server dist not built (run `pnpm build` first)", () => {
  expect(distBuilt).toBe(false);
});
