import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import * as YAML from "yaml";
import {
  DEFAULT_LEDGER_CONFIG,
  LedgerGit,
  PermissionsManifest,
  journalPath,
  mintVaultId,
  permissionsPath,
  writeConfig,
} from "@vault-ledger/core";
import { resolveMcpServerEntry } from "../../src/setup/mcpConfig.js";
import { interpretStatus, smokeCheck } from "../../src/setup/smoke.js";

/**
 * `smokeCheck` is split into a PURE interpreter (`interpretStatus`, unit
 * tested here without any subprocess) and the real-subprocess spawn (the
 * integration suite below, which needs `pnpm -C packages/mcp-server build`).
 */

/** Build a CallToolResult-shaped object with a single JSON text content. */
function toolResult(payload: unknown, isError = false): { content: Array<{ type: string; text?: string }>; isError: boolean } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError };
}

describe("interpretStatus (pure)", () => {
  test("a healthy ledger_status result: ok with zoneGlobs + pending counts", () => {
    const res = toolResult({
      zones: { trusted: ["**"], agent: ["Agent/**"], scratch: ["Agent/Scratch/**"], excluded: ["Private/**"] },
      pendingApprovals: [{ id: "apr_1" }, { id: "apr_2" }],
      recentTransactions: [],
    });
    const interp = interpretStatus(res);
    expect(interp.ok).toBe(true);
    if (!interp.ok) return;
    expect(interp.zoneGlobs).toBe(4);
    expect(interp.pending).toBe(2);
  });

  test("an isError:true result routes to NOT ok (the false-positive guard)", () => {
    // ledger_status's handler catches internal errors and returns a
    // structured { error } payload with isError:true — NOT a rejection. This
    // is exactly the shape that parsed fine and reported "verified" before.
    const res = toolResult(
      { error: { code: "INTERNAL_ERROR", message: "journal is corrupt", retriable: false } },
      true,
    );
    const interp = interpretStatus(res);
    expect(interp.ok).toBe(false);
    if (interp.ok) return;
    expect(interp.reason).toContain("journal is corrupt");
  });

  test("an { error } payload with isError falsy still routes to NOT ok", () => {
    const res = toolResult({ error: { code: "INVALID_ARGS", message: "bad args", retriable: false } }, false);
    const interp = interpretStatus(res);
    expect(interp.ok).toBe(false);
    if (interp.ok) return;
    expect(interp.reason).toContain("bad args");
  });
});

let vaultDir: string;
let homeDir: string;

afterEach(() => {
  if (vaultDir) rmSync(vaultDir, { recursive: true, force: true });
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
});

async function makeSmokeVault(): Promise<{ vaultDir: string; vaultId: string }> {
  const dir = mkdtempSync(join(tmpdir(), "vl-smoke-vault-"));
  const manifest = PermissionsManifest.parse({
    mode: "assisted",
    zones: {
      trusted: ["**"],
      agent: ["Agent/**"],
      scratch: ["Agent/Scratch/**"],
      excluded: ["Private/**"],
    },
    overrides: [],
  });
  const git = new LedgerGit(dir);
  await git.init();
  mkdirSync(join(dir, ".ledger"), { recursive: true });
  writeFileSync(permissionsPath(dir), YAML.stringify(manifest), "utf8");
  const vaultId = mintVaultId(() => "smoketest1");
  writeConfig(dir, { ...DEFAULT_LEDGER_CONFIG, vaultId });
  return { vaultDir: dir, vaultId };
}

const entry = resolveMcpServerEntry();
const distBuilt = entry !== null;

if (!distBuilt) {
  // Make the skip LOUD so a clean checkout's green `pnpm test` can't hide the
  // fact that the real-subprocess coverage never ran.
  console.warn(
    "[smoke.test] SKIPPED real-subprocess tests: mcp-server dist not built — run `pnpm -C packages/mcp-server build`",
  );
}

describe.skipIf(!distBuilt)("smokeCheck (real subprocess, real MCP client)", () => {
  test(
    "a good entry verifies over the temp-HOME-isolated journal",
    async () => {
      const seeded = await makeSmokeVault();
      vaultDir = seeded.vaultDir;
      homeDir = mkdtempSync(join(tmpdir(), "vl-smoke-home-"));
      const env = { ...process.env, HOME: homeDir };

      const dbPath = journalPath(seeded.vaultId, env);
      expect(existsSync(dirname(dbPath))).toBe(false);

      const result = await smokeCheck(vaultDir, entry!, env);

      expect(result.step).toBe("smoke");
      expect(result.state).toBe("verified");
      expect(result.detail).toMatch(/\d+ zone globs, journal healthy, \d+ pending/);

      // Proves the child actually opened the TEMP-HOME journal, not the real
      // developer app-support dir: the app-support directory for this
      // vaultId now exists under the temp HOME.
      expect(existsSync(dirname(dbPath))).toBe(true);
    },
    20_000,
  );

  test(
    "a bad entry fails with a detail naming the entry path and captured stderr",
    async () => {
      vaultDir = mkdtempSync(join(tmpdir(), "vl-smoke-vault-bad-"));
      homeDir = mkdtempSync(join(tmpdir(), "vl-smoke-home-bad-"));
      const env = { ...process.env, HOME: homeDir };
      const badEntry = "/nonexistent/index.js";

      const result = await smokeCheck(vaultDir, badEntry, env);

      expect(result.step).toBe("smoke");
      expect(result.state).toBe("failed");
      expect(result.detail).toContain(badEntry);
      // The child's crash output (MODULE_NOT_FOUND) is CAPTURED into the
      // detail, not inherited to the parent terminal.
      expect(result.detail).toMatch(/stderr/i);
    },
    20_000,
  );

  test(
    "a server that spawns but never speaks MCP times out (no hang, child reaped)",
    async () => {
      vaultDir = mkdtempSync(join(tmpdir(), "vl-smoke-vault-hang-"));
      homeDir = mkdtempSync(join(tmpdir(), "vl-smoke-home-hang-"));
      const env = { ...process.env, HOME: homeDir };

      // A process that starts and stays alive forever without ever writing a
      // JSON-RPC frame — the connect handshake will never complete.
      const hangJs = join(vaultDir, "hang.js");
      writeFileSync(hangJs, "setInterval(() => {}, 1e9);\n", "utf8");

      const start = Date.now();
      const result = await smokeCheck(vaultDir, hangJs, env, 200);
      const elapsed = Date.now() - start;

      expect(result.state).toBe("failed");
      // The 200ms timeout fired and cleaned up well within the test budget —
      // proving withTimeout's timer rejected and the client/child were torn
      // down rather than hanging the event loop.
      expect(elapsed).toBeLessThan(5000);
    },
    20_000,
  );
});

test.skipIf(distBuilt)("smoke test skipped: mcp-server dist not built (run `pnpm build` first)", () => {
  expect(distBuilt).toBe(false);
});
