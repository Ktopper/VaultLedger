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
const SERVER_ENTRY = join(__dirname, "..", "dist", "index.js");

/**
 * Real end-to-end proof that the shipped bin actually works: spawn the
 * BUILT server (`dist/index.js`, the exact file `vaultledger-mcp` resolves
 * to) as a subprocess, speak real MCP over stdio via the SDK's own Client +
 * StdioClientTransport, and drive a real handshake + tool listing + tool
 * call. Everything else in this test suite drives tool handlers in-process
 * (createServer().callTool) for determinism/speed — this is the one test
 * that proves the actual entrypoint (shebang, --vault parsing, stdio
 * framing) works, not just the handler logic behind it.
 *
 * Requires `pnpm build` to have produced packages/mcp-server/dist/index.js
 * (and packages/core/dist, which it depends on). If dist is missing —
 * e.g. a test run before the first build — this test skips itself with a
 * clear message rather than failing opaquely on ENOENT.
 */
const distBuilt = existsSync(SERVER_ENTRY);

describe.skipIf(!distBuilt)("mcp-server stdio entrypoint (real subprocess + real MCP client)", () => {
  test(
    "handshake, list 9 tools, call ledger_status",
    async () => {
      const vaultDir = mkdtempSync(join(tmpdir(), "vl-stdio-vault-"));
      const homeDir = mkdtempSync(join(tmpdir(), "vl-stdio-home-"));

      try {
        // Initialize a minimal real vault on disk (config + permissions + git)
        // so the spawned server's loadServerContext succeeds.
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
        writeConfig(vaultDir, { ...DEFAULT_LEDGER_CONFIG, vaultId: mintVaultId(() => "stdiosmoke1") });

        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [SERVER_ENTRY, "--vault", vaultDir],
          env: { ...process.env, HOME: homeDir },
          stderr: "pipe",
        });
        const client = new Client({ name: "vaultledger-smoke-client", version: "0.0.1" });
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
          expect(names.length).toBe(9);

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

test.skipIf(distBuilt)("stdio smoke test skipped: dist/index.js not built (run `pnpm build` first)", () => {
  expect(distBuilt).toBe(false);
});
