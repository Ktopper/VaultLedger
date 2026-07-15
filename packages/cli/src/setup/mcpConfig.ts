import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Resolve the built mcp-server entry via Node module resolution — works in
 * the monorepo via the workspace symlink (packages/cli depends on
 * @vault-ledger/mcp-server) AND under a future npx/npm install, with no
 * repo-relative path math. Returns an absolute path to the built
 * `dist/index.js`, or null if the package isn't resolvable / isn't built.
 *
 * Approach: plain `require.resolve("@vault-ledger/mcp-server")`. The
 * package's package.json declares both `main` and `exports["."].default`
 * pointing at `./dist/index.js`, and Node's CJS resolver honors the
 * `exports` map's `default` condition for `require.resolve` — so this
 * resolves straight to the built entry without needing a package.json +
 * field-join fallback.
 */
export function resolveMcpServerEntry(): string | null {
  const require = createRequire(import.meta.url);
  try {
    const entry = require.resolve("@vault-ledger/mcp-server");
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
  | { ok: true; text: string; state: "created" | "updated" | "already" }
  | { ok: false; reason: "unparseable" | "not-an-object" };

/** Serialize with 2-space indent and a trailing LF. Output is ALWAYS
 * LF-newline (JSON.stringify emits no CR), independent of host platform. */
function serialize(o: unknown): string {
  return JSON.stringify(o, null, 2) + "\n";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Structural equality for the plain-JSON-shaped values `mergeMcpConfig`
 * works with (objects/arrays/primitives — no cycles, no Dates/Maps/etc,
 * since both sides always come from `JSON.parse`/object-literal
 * construction). Used to detect a true semantic no-op re-run so the caller
 * can skip the rewrite entirely and report `already` instead of `updated`. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Merge the vaultledger MCP server entry into an existing `.mcp.json` text
 * (or create fresh if there is none). THE safety property: this must never
 * drop a sibling server, and must never return `ok:true` on unparseable
 * input.
 *
 * - `existingText === null` → no file yet, create fresh (`state:"created"`).
 * - Existing text that isn't valid JSON → `ok:false, reason:"unparseable"`
 *   (caller must not overwrite an existing file it can't understand).
 * - Existing text that parses but is NOT a plain object (array / scalar /
 *   `null` literal) → `ok:false, reason:"not-an-object"`. We refuse rather
 *   than default to `{}`, because defaulting would silently DROP that payload
 *   when the caller writes our result over the real file.
 * - Otherwise: parse, preserve every top-level key of the parsed object via
 *   spread, preserve every existing `mcpServers` entry via spread, and
 *   deep-merge our `{command,args}` INTO the existing `vaultledger` object so
 *   the user's extra fields (`env`, `disabled`, …) survive while our path
 *   fields win.
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

  if (!isPlainObject(parsed)) {
    return { ok: false, reason: "not-an-object" };
  }
  const parsedObj = parsed;

  const rawServers = parsedObj.mcpServers;
  const servers: Record<string, unknown> = isPlainObject(rawServers) ? rawServers : {};

  const had = Object.prototype.hasOwnProperty.call(servers, "vaultledger");
  // Deep-merge: keep the user's extra keys on the existing vaultledger entry
  // (env secrets, disabled flag, …); our command/args overwrite (the entry
  // path may have changed). Only spread the existing entry if it's an object.
  const existingEntry = servers.vaultledger;
  const mergedEntry = isPlainObject(existingEntry) ? { ...existingEntry, ...ours } : ours;
  const merged = { ...parsedObj, mcpServers: { ...servers, vaultledger: mergedEntry } };

  // A true semantic no-op (re-running against an already-current config)
  // reports `already` rather than `updated`, and the caller skips the
  // rewrite entirely — an idempotent re-run must not touch the file's mtime.
  if (had && deepEqual(merged, parsedObj)) {
    return { ok: true, state: "already", text: serialize(merged) };
  }

  return { ok: true, state: had ? "updated" : "created", text: serialize(merged) };
}

/** Atomically write `text` to `path`: create parent directories as needed,
 * write to a sibling `.tmp` file, then rename over the destination so a
 * crash mid-write never leaves a half-written config in place.
 *
 * temp+rename swaps inodes, so a fresh `.tmp` created with the default umask
 * would loosen a restrictive mode on the existing target (a `.mcp.json` can
 * hold sibling servers' `env` secrets and may be chmod'd 600). If the target
 * already exists, copy its mode onto the temp file before the rename. On a
 * fresh create we leave the default mode. */
export function writeMcpConfig(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, text, "utf8");
  if (existsSync(path)) {
    chmodSync(tmpPath, statSync(path).mode & 0o777);
  }
  renameSync(tmpPath, path);
}
