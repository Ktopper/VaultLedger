import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { StepResult } from "./types.js";

/** Race a promise against a rejecting timer, always clearing the timer on
 * settle so a timed-out (or won) race never keeps the event loop alive. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Drop `undefined` values from a `NodeJS.ProcessEnv` — `process.env`'s
 * index signature is `string | undefined`, but `StdioClientTransport`'s
 * `env` wants `Record<string, string>`. */
function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * `ledger setup`'s smoke step: spawn the EXACT emitted server command
 * (`node <entry> --vault <vault> --no-sweep`, the same shape
 * `buildMcpConfig` writes into `.mcp.json`) over real stdio via the MCP SDK
 * client, and call the read-only `ledger_status` tool to prove the server
 * starts, opens the journal, and answers — without mutating the vault.
 *
 * `--no-sweep` is load-bearing here: `ledger setup` is a print-by-default
 * command that must touch nothing outside `.ledger/`, and without it the
 * spawned server's startup TTL sweep would archive expired scratch as a
 * side effect of merely verifying itself.
 *
 * `env` defaults to `process.env` in production; tests pass a temp HOME so
 * the spawned child opens an isolated journal rather than the real
 * developer's app-support journal — `StdioClientTransport` merges
 * `{...getDefaultEnvironment(), ...env}`, so an explicit HOME here wins.
 */
export async function smokeCheck(
  vault: string,
  entry: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StepResult> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [entry, "--vault", vault, "--no-sweep"],
    env: definedEnv(env),
  });
  const client = new Client({ name: "ledger-setup-smoke", version: "0.4.0" }, { capabilities: {} });
  try {
    await withTimeout(client.connect(transport), 8000);
    const res = await withTimeout(client.callTool({ name: "ledger_status", arguments: {} }), 8000);
    const content = res.content as Array<{ type: string; text?: string }> | undefined;
    const status = JSON.parse(content?.[0]?.text ?? "{}") as {
      zones?: Record<string, unknown>;
      pendingApprovals?: unknown[];
    };
    const zoneGlobs = Object.values(status.zones ?? {}).flat().length;
    const pending = (status.pendingApprovals ?? []).length;
    return {
      step: "smoke",
      state: "verified",
      detail: `${zoneGlobs} zone globs, journal healthy, ${pending} pending`,
    };
  } catch (e) {
    return { step: "smoke", state: "failed", detail: `server did not respond (${entry}): ${msg(e)}` };
  } finally {
    await client.close().catch(() => {});
  }
}
