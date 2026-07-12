import { createRequire } from "node:module";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Resolve the built mcp-server entry via Node module resolution — works in
 * the monorepo via the workspace symlink (packages/cli depends on
 * @vaultledger/mcp-server) AND under a future npx/npm install, with no
 * repo-relative path math. Returns an absolute path to the built
 * `dist/index.js`, or null if the package isn't resolvable / isn't built.
 *
 * Approach: plain `require.resolve("@vaultledger/mcp-server")`. The
 * package's package.json declares both `main` and `exports["."].default`
 * pointing at `./dist/index.js`, and Node's CJS resolver honors the
 * `exports` map's `default` condition for `require.resolve` — so this
 * resolves straight to the built entry without needing a package.json +
 * field-join fallback.
 */
export function resolveMcpServerEntry(): string | null {
  const require = createRequire(import.meta.url);
  try {
    const entry = require.resolve("@vaultledger/mcp-server");
    return existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

export interface McpServerEntryConfig {
  command: string;
  args: string[];
}

export interface McpConfig {
  mcpServers: {
    vaultledger: McpServerEntryConfig;
  };
}

/** Build the vaultledger MCP server config block. Both `vault` and `entry`
 * must already be absolute — this function does no resolution of its own. */
export function buildMcpConfig(vault: string, entry: string): McpConfig {
  return {
    mcpServers: {
      vaultledger: { command: "node", args: [entry, "--vault", vault] },
    },
  };
}

export type MergeResult =
  | { ok: true; text: string; state: "created" | "updated" }
  | { ok: false; reason: "unparseable" };

function serialize(o: unknown): string {
  return JSON.stringify(o, null, 2) + "\n";
}

/**
 * Merge the vaultledger MCP server entry into an existing `.mcp.json` text
 * (or create fresh if there is none). THE safety property: this must never
 * drop a sibling server, and must never return `ok:true` on unparseable
 * input.
 *
 * - `existingText === null` → no file yet, create fresh (`state:"created"`).
 * - Existing text that isn't valid JSON → `ok:false` (caller must not
 *   overwrite an existing file it can't understand).
 * - Otherwise: parse, preserve every top-level key of the parsed object via
 *   spread, preserve every existing `mcpServers` entry via spread, and only
 *   ever write/replace the single `vaultledger` key.
 */
export function mergeMcpConfig(existingText: string | null, vault: string, entry: string): MergeResult {
  const ours = buildMcpConfig(vault, entry).mcpServers.vaultledger;

  if (existingText === null) {
    return { ok: true, state: "created", text: serialize({ mcpServers: { vaultledger: ours } }) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(existingText);
  } catch {
    return { ok: false, reason: "unparseable" };
  }

  const parsedObj: Record<string, unknown> =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};

  const rawServers = parsedObj.mcpServers;
  const servers: Record<string, unknown> =
    rawServers !== null && typeof rawServers === "object" && !Array.isArray(rawServers)
      ? (rawServers as Record<string, unknown>)
      : {};

  const had = Object.prototype.hasOwnProperty.call(servers, "vaultledger");
  const merged = { ...parsedObj, mcpServers: { ...servers, vaultledger: ours } };

  return { ok: true, state: had ? "updated" : "created", text: serialize(merged) };
}

/** Atomically write `text` to `path`: create parent directories as needed,
 * write to a sibling `.tmp` file, then rename over the destination so a
 * crash mid-write never leaves a half-written config in place. */
export function writeMcpConfig(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, text, "utf8");
  renameSync(tmpPath, path);
}
