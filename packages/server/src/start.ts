import type { FastifyInstance } from "fastify";
import { openVault, type VaultContext } from "@vault-ledger/core";
import { buildBridge } from "./app.js";

export interface StartBridgeOptions {
  token: string;
  /** Bind port. Defaults to 0 (OS-assigned ephemeral port) — the actual
   * bound port is always read back from the listening server afterward, so
   * callers never need to guess or pre-reserve one. */
  port?: number;
  now?: () => string;
  genId?: (prefix: string) => string;
  env?: NodeJS.ProcessEnv;
}

export interface RunningBridge {
  app: FastifyInstance;
  /** The actual bound port (never 0 — read back from the listening server's
   * own address, even when `port` was omitted/0 and the OS assigned one). */
  port: number;
  token: string;
  /** Stops accepting connections and releases the vault (journal db handle).
   * Call exactly once. */
  close: () => Promise<void>;
}

/**
 * Open a vault the same way every other host does (`openVault` — the single
 * wiring path all hosts converge on, design v0.2 §host wiring) and start the
 * fastify bridge over it, listening on loopback only. Runs the TTL sweep at
 * startup (`sweep: true`) since, like the MCP server, this is a long-running
 * session host rather than a one-shot read-only CLI invocation.
 */
export async function startBridge(vaultRoot: string, opts: StartBridgeOptions): Promise<RunningBridge> {
  const ctx: VaultContext = await openVault(vaultRoot, {
    sweep: true,
    now: opts.now,
    genId: opts.genId,
    env: opts.env,
  });

  const app: FastifyInstance = buildBridge(ctx, opts.token);
  try {
    await app.listen({ host: "127.0.0.1", port: opts.port ?? 0 });
  } catch (e) {
    // Mirror openVault's own "close what we opened" contract on a startup
    // failure — a caller that never receives a RunningBridge must not be left
    // to guess whether the journal db handle (or the half-started fastify
    // instance) leaked. Close BOTH: the fastify app (best-effort — it may
    // have bound partially / registered listeners before listen() rejected)
    // AND the journal db handle.
    try {
      await app.close();
    } catch {
      // best-effort: never mask the original listen() failure with a
      // close() error.
    }
    ctx.close();
    throw e;
  }

  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : (opts.port ?? 0);

  return {
    app,
    port,
    token: opts.token,
    close: async () => {
      await app.close();
      ctx.close();
    },
  };
}
