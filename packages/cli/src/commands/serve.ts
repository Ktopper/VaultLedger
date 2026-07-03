import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrokerError, readConfig, vaultLockDir } from "@vaultledger/core";
import { startBridge } from "@vaultledger/server";

export interface ServeOptions {
  port?: number;
  rotateToken?: boolean;
  now?: () => string;
  genId?: (prefix: string) => string;
  env?: NodeJS.ProcessEnv;
  /** Injectable token minter — makes tests deterministic. Defaults to a
   * crypto-random 24-byte hex string. A fresh `serveCommand` call ALWAYS
   * mints a new token (v0.1 simplicity: there is no "reuse the previous
   * token" path); `--rotate-token` is simply the documented name for this
   * same always-mint behavior. */
  mintToken?: () => string;
  out?: (s: string) => void;
  /** Register real process-level SIGINT/SIGTERM handlers that call the
   * returned handle's close(). Defaults to true (the real CLI wants this);
   * tests set it to false and call close() directly instead, so a unit test
   * never installs a process-global signal handler or leaves one dangling
   * after the test file finishes. */
  installSignalHandlers?: boolean;
}

export interface ServeHandle {
  port: number;
  token: string;
  bridgePath: string;
  close(): Promise<void>;
}

const NOT_INITIALIZED_MESSAGE = "not a VaultLedger vault (run `ledger init` first)";

function defaultMintToken(): string {
  return randomBytes(24).toString("hex");
}

/**
 * Start the local HTTP bridge (`@vaultledger/server`'s startBridge) over
 * `vaultDir` and publish a runtime discovery file — `<app-support>/<vaultId>
 * /bridge.json` — the Obsidian plugin reads to find {port, token}. The
 * discovery file is written OUTSIDE the vault (app-support, not `.ledger/`)
 * because `.ledger/` syncs with the vault (design invariant: `.ledger/` is
 * the only in-vault footprint) and a bridge token must never leave this
 * machine. It's created 0o600 (owner-only) since it grants approve/undo
 * over the vault via the bridge.
 */
export async function serveCommand(vaultDir: string, opts: ServeOptions = {}): Promise<ServeHandle> {
  let vaultId: string;
  try {
    ({ vaultId } = readConfig(vaultDir));
  } catch (e) {
    if (e instanceof BrokerError && e.code === "NOT_FOUND") {
      throw new Error(NOT_INITIALIZED_MESSAGE);
    }
    throw e;
  }

  const out = opts.out ?? console.log;
  const now = opts.now ?? (() => new Date().toISOString());
  const mintToken = opts.mintToken ?? defaultMintToken;
  const installSignalHandlers = opts.installSignalHandlers !== false;

  // Same per-vault app-support directory core's vaultLockDir/journalPath use
  // — the discovery file lives alongside the journal it points at, keyed by
  // vaultId (never a path hash), so it survives the vault moving on disk.
  const appDir = vaultLockDir(vaultId, opts.env);
  const bridgePath = join(appDir, "bridge.json");
  mkdirSync(appDir, { recursive: true });

  const token = mintToken();

  const running = await startBridge(vaultDir, {
    token,
    port: opts.port ?? 0,
    now,
    genId: opts.genId,
    env: opts.env,
  });

  const startedAt = now();
  const contents = JSON.stringify({ port: running.port, token, pid: process.pid, startedAt }, null, 2);
  writeFileSync(bridgePath, contents, { mode: 0o600 });
  // umask can weaken the mode passed to writeFileSync's own create — chmod
  // explicitly so the file is never group/world readable regardless of the
  // process umask (it holds a live bridge token granting approve/undo).
  chmodSync(bridgePath, 0o600);

  out(`VaultLedger bridge on http://127.0.0.1:${running.port} (token in ${bridgePath})`);

  let closed = false;
  let onSignal: (() => void) | undefined;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (installSignalHandlers && onSignal) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
    await running.close();
    if (existsSync(bridgePath)) {
      unlinkSync(bridgePath);
    }
  };

  if (installSignalHandlers) {
    onSignal = (): void => {
      void close().then(() => process.exit(0));
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }

  return { port: running.port, token, bridgePath, close };
}
