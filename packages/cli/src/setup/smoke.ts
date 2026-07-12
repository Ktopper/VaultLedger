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

/** Format captured child stderr for inclusion in a failure detail: trimmed,
 * capped to the last ~500 chars (the tail is where the crash/error is), and
 * empty-string when there was nothing so the detail stays clean. */
function stderrTail(buf: string): string {
  const trimmed = buf.trim();
  if (!trimmed) return "";
  const capped = trimmed.length > 500 ? trimmed.slice(-500) : trimmed;
  return ` [stderr: ${capped}]`;
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

/** The minimal CallToolResult shape `interpretStatus` reads. */
export interface RawToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export type StatusInterpretation =
  | { ok: true; zoneGlobs: number; pending: number }
  | { ok: false; reason: string };

/**
 * Pure interpreter of a `ledger_status` CallToolResult. Extracted from
 * `smokeCheck` so the failure-detection logic is unit-testable without a
 * corrupt journal or a real subprocess.
 *
 * CRITICAL: a tool handler that hits an internal error does NOT reject —
 * `ledger_status` catches it and returns `{ content:[{text:
 * JSON.stringify({error})}], isError:true }`. Treating that as success (it
 * parses fine; `zones`/`pendingApprovals` are just absent) would report
 * "verified" on exactly the failure this step exists to catch. So an
 * `isError` flag OR an `error` key in the payload routes to `ok:false`.
 */
export function interpretStatus(res: RawToolResult): StatusInterpretation {
  const text = res.content?.[0]?.text ?? "{}";
  let parsed: {
    zones?: Record<string, unknown>;
    pendingApprovals?: unknown[];
    error?: { code?: string; message?: string };
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: `unparseable ledger_status result: ${text.slice(0, 200)}` };
  }
  if (res.isError || parsed.error) {
    const message = parsed.error?.message ?? "server returned an error result";
    const code = parsed.error?.code;
    return { ok: false, reason: code ? `${code}: ${message}` : message };
  }
  const zoneGlobs = Object.values(parsed.zones ?? {}).flat().length;
  const pending = (parsed.pendingApprovals ?? []).length;
  return { ok: true, zoneGlobs, pending };
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
 *
 * `timeoutMs` bounds BOTH the connect handshake and the tool call so a
 * child that spawns but never speaks MCP can't hang setup; tests shrink it
 * to exercise the timeout path fast.
 */
export async function smokeCheck(
  vault: string,
  entry: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 8000,
): Promise<StepResult> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [entry, "--vault", vault, "--no-sweep"],
    env: definedEnv(env),
    // Capture the child's stderr rather than inheriting it: a bare
    // MODULE_NOT_FOUND / startup crash must land in the failure detail, not
    // dumped raw to the parent terminal (which would corrupt `--json`
    // output). With "pipe", the SDK exposes a PassThrough on `transport.
    // stderr` immediately, so this listener is attached before the child runs.
    stderr: "pipe",
  });
  let stderrBuf = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf8");
  });
  const client = new Client({ name: "ledger-setup-smoke", version: "0.4.0" }, { capabilities: {} });
  try {
    await withTimeout(client.connect(transport), timeoutMs);
    const res = await withTimeout(client.callTool({ name: "ledger_status", arguments: {} }), timeoutMs);
    const interp = interpretStatus(res as RawToolResult);
    if (!interp.ok) {
      return {
        step: "smoke",
        state: "failed",
        detail: `ledger_status failed (${entry}): ${interp.reason}${stderrTail(stderrBuf)}`,
      };
    }
    return {
      step: "smoke",
      state: "verified",
      detail: `${interp.zoneGlobs} zone globs, journal healthy, ${interp.pending} pending`,
    };
  } catch (e) {
    return {
      step: "smoke",
      state: "failed",
      detail: `server did not respond (${entry}): ${msg(e)}${stderrTail(stderrBuf)}`,
    };
  } finally {
    await client.close().catch(() => {});
  }
}
