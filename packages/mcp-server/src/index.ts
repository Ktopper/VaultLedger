#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { loadServerContext, type ServerContext } from "./context.js";
import { buildTools, type ToolDef } from "./tools.js";

const SERVER_NAME = "vaultledger-mcp";
// Keep in sync with packages/mcp-server/package.json "version".
const SERVER_VERSION = "0.3.0";

/** Static tool-name list, independent of any ServerContext — used by the
 * placeholder smoke test and anything that just wants the tool surface
 * without spinning up a real vault. `buildTools` (over a live ServerContext)
 * is the source of truth for the actual registered tools; a tools.test.ts
 * assertion keeps the two in sync. */
export function listToolNames(): string[] {
  return [
    "memory_recall",
    "memory_remember",
    "memory_distill",
    "memory_revise",
    "memory_promote",
    "memory_forget",
    "memory_retire",
    "vault_propose_edit",
    "ledger_status",
  ];
}

export interface CreatedServer {
  server: Server;
  tools: ToolDef[];
  /** Invoke a registered tool by name exactly as the CallTool request
   * handler does, without going through JSON-RPC framing or a real
   * transport — this is what integration tests drive directly. */
  callTool: (name: string, args: unknown) => Promise<CallToolResult>;
}

function toCallToolResult(result: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    isError: Boolean(result.error),
  };
}

/**
 * Wire the 9 tools from `buildTools(ctx)` onto a real MCP `Server`: a
 * ListTools handler that reports each tool's name/description/JSON-schema
 * (converted from its zod inputSchema via zod-to-json-schema), and a
 * CallTool handler that dispatches to the matching tool's handler and
 * returns its result as JSON text content. Exported (rather than inlined in
 * main()) so tests can exercise the exact same request-handling logic
 * without spawning a subprocess or speaking real stdio JSON-RPC.
 */
export function createServer(ctx: ServerContext): CreatedServer {
  const tools = buildTools(ctx);

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  async function callTool(name: string, args: unknown): Promise<CallToolResult> {
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      return toCallToolResult({
        error: { code: "NOT_FOUND", message: `unknown tool: ${name}`, retriable: false },
      });
    }
    const result = await tool.handler(args);
    return toCallToolResult(result);
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema, { target: "jsonSchema7" }) as Record<string, unknown>,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(request.params.name, request.params.arguments ?? {}),
  );

  return { server, tools, callTool };
}

/**
 * Extract and normalize the required `--vault <path>` argument. Resolves the
 * path to absolute (`path.resolve`) so a relative `--vault` never depends on
 * the unpredictable cwd of whatever host process launched the server. Throws
 * a clear, prefixed diagnostic (surfaced to stderr + a non-zero exit by
 * `main`) when the flag is missing. Exported for unit testing. */
export function parseVaultArg(argv: string[]): string {
  const idx = argv.indexOf("--vault");
  const value = idx === -1 ? undefined : argv[idx + 1];
  if (!value) {
    throw new Error("vaultledger-mcp: --vault <path> is required");
  }
  return resolve(value);
}

/** Extract the `--no-sweep` flag (design: pairs with `LoadServerContextDeps.
 * skipSweep` — `ledger setup`'s smoke check spawns the real server and must
 * verify it without the startup TTL sweep mutating the vault). Orthogonal to
 * `--vault`: presence/position of one must never affect parsing of the
 * other. Exported for unit testing. */
export function parseNoSweep(argv: string[]): boolean {
  return argv.includes("--no-sweep");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const vaultRoot = parseVaultArg(argv);
  const skipSweep = parseNoSweep(argv);
  const ctx = await loadServerContext(vaultRoot, { skipSweep });

  let server: Server;
  try {
    ({ server } = createServer(ctx));
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (e) {
    // If wiring/connecting the transport fails after the context loaded, the
    // caller (main's catch) never gets a running server to shut down — honor
    // the "caller owns db.close()" contract by closing here before rethrowing.
    ctx.db.close();
    throw e;
  }

  // The server is long-running, so there is no `finally` to close the db on —
  // instead, close both the transport and the journal handle on a termination
  // signal. idempotent-ish: the process exits immediately after.
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void server.close().finally(() => {
      ctx.db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only run main() when this file is the process entrypoint (the `bin`
// script), not when a test imports `createServer`/`listToolNames`/
// `parseVaultArg` from it. Compares via pathToFileURL (not a bare
// `file://${process.argv[1]}` template) so this still matches when the path
// contains characters (spaces, unicode, ...) that import.meta.url
// percent-encodes — a bare template-literal comparison would silently never
// match (and so never run main()) for any install/vault path containing a
// space, which is common enough (this very repo's path included) to be a
// real bug rather than a hypothetical one.
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
