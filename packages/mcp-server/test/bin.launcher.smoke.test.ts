import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as YAML from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  DEFAULT_LEDGER_CONFIG,
  LedgerGit,
  PermissionsManifest,
  mintVaultId,
  permissionsPath,
  writeConfig,
} from "@vault-ledger/core";
import { listToolNames } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LAUNCHER_ENTRY = join(__dirname, "..", "bin", "vaultledger-mcp.mjs");
const DIST_ENTRY = join(__dirname, "..", "dist", "index.js");

/**
 * Proves the COMMITTED bin launcher (`packages/mcp-server/bin/
 * vaultledger-mcp.mjs`, what `"bin": { "vaultledger-mcp": ... }` in
 * package.json actually points at) boots the real server — not just that
 * `dist/index.js` works when run directly (that's `stdio.smoke.test.ts`).
 *
 * Same regression shape as the CLI's `bin.launcher.test.ts`: the launcher
 * imports `dist/index.js` and calls its exported `main()` explicitly,
 * because `isMainModule` is false when invoked via the launcher. A launcher
 * that forgot to call `main()` would spawn a process that connects nothing
 * and never responds to the handshake below — this test would hang/fail
 * rather than silently pass.
 *
 * Guarded on the built dist (the launcher needs it at runtime) like the
 * direct-entry smoke test.
 */
const distBuilt = existsSync(DIST_ENTRY);

describe.skipIf(!distBuilt)("vaultledger-mcp bin launcher (the actual package.json \"bin\" target)", () => {
  test(
    "handshake + ledger_status via the launcher path",
    async () => {
      const vaultDir = mkdtempSync(join(tmpdir(), "vl-launcher-vault-"));
      const homeDir = mkdtempSync(join(tmpdir(), "vl-launcher-home-"));

      try {
        const manifest = PermissionsManifest.parse({
          mode: "assisted",
          zones: {
            trusted: ["**"],
            agent: ["Agent/**"],
            scratch: ["Agent/Scratch/**"],
            excluded: [".obsidian/**"],
          },
          overrides: [],
        });
        const git = new LedgerGit(vaultDir);
        await git.init();
        mkdirSync(join(vaultDir, ".ledger"), { recursive: true });
        writeFileSync(permissionsPath(vaultDir), YAML.stringify(manifest), "utf8");
        writeConfig(vaultDir, { ...DEFAULT_LEDGER_CONFIG, vaultId: mintVaultId(() => "launchersmoke1") });

        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [LAUNCHER_ENTRY, "--vault", vaultDir, "--no-sweep"],
          env: { ...process.env, HOME: homeDir },
          stderr: "pipe",
        });
        const client = new Client({ name: "vaultledger-launcher-smoke-client", version: "0.0.1" });
        let stderrOutput = "";
        transport.stderr?.on("data", (chunk: Buffer) => {
          stderrOutput += chunk.toString("utf8");
        });

        try {
          try {
            await client.connect(transport);
          } catch (e) {
            throw new Error(`connect failed; server stderr:\n${stderrOutput}\n\noriginal: ${String(e)}`);
          }

          const { tools } = await client.listTools();
          const names = tools.map((t) => t.name).sort();
          expect(names).toEqual([...listToolNames()].sort());

          const statusResult = await client.callTool({ name: "ledger_status", arguments: {} });
          expect(statusResult.isError).toBeFalsy();
          const content = statusResult.content as Array<{ type: string; text?: string }>;
          const parsed = JSON.parse(content[0]?.text ?? "{}") as {
            zones: unknown;
            pendingApprovals: unknown[];
            recentTransactions: unknown[];
          };
          expect(parsed.zones).toBeDefined();
          expect(Array.isArray(parsed.pendingApprovals)).toBe(true);
          expect(Array.isArray(parsed.recentTransactions)).toBe(true);
        } finally {
          await client.close();
        }
      } finally {
        rmSync(vaultDir, { recursive: true, force: true });
        rmSync(homeDir, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

test.skipIf(distBuilt)("bin.launcher.smoke test skipped: dist/index.js not built (run `pnpm build` first)", () => {
  expect(distBuilt).toBe(false);
});
