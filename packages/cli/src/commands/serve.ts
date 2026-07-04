import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrokerError, readConfig, vaultLockDir } from "@vaultledger/core";
import { startBridge } from "@vaultledger/server";

export interface ServeOptions {
  port?: number;
  /** Mint a fresh bridge token even when a prior (crashed) serve left a
   * reusable one behind — i.e. deliberately REVOKE the previous session
   * token. Without this flag a dead-pid bridge.json's token is reused so a
   * client that already read it keeps working across the restart. */
  rotateToken?: boolean;
  now?: () => string;
  genId?: (prefix: string) => string;
  env?: NodeJS.ProcessEnv;
  /** Injectable token minter — makes tests deterministic. Defaults to a
   * crypto-random 24-byte hex string. */
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

interface BridgeFile {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

const NOT_INITIALIZED_MESSAGE = "not a VaultLedger vault (run `ledger init` first)";

function defaultMintToken(): string {
  return randomBytes(24).toString("hex");
}

/**
 * Is `pid` a live process? `process.kill(pid, 0)` sends no signal but still
 * performs the existence + permission check: it succeeds for a live process
 * we own, throws EPERM for a live process we DON'T own (still alive → true),
 * and throws ESRCH when no such process exists (dead → false).
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read + validate an existing bridge.json. Returns undefined if it's absent
 * or malformed (a corrupt discovery file is treated as "no incumbent" — the
 * fresh serve simply overwrites it). */
function readBridgeFile(bridgePath: string): BridgeFile | undefined {
  if (!existsSync(bridgePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(bridgePath, "utf8")) as Partial<BridgeFile>;
    if (
      typeof parsed.port === "number" &&
      typeof parsed.token === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.startedAt === "string"
    ) {
      return parsed as BridgeFile;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Publish bridge.json atomically: write the JSON to a freshly-created temp
 * file in the SAME app-support dir with `{ mode: 0o600 }` (the create mode is
 * honored because the inode is brand new — no pre-existing, possibly
 * world-readable, permissions to inherit), then renameSync it into place. The
 * rename is atomic on one filesystem and preserves the temp file's 0600, so
 * there is never an observable window where the new content is world-readable
 * (closing the TOCTOU a write-then-chmod on the final path would leave open),
 * and a crash mid-write can never leave a truncated discovery file.
 */
function writeBridgeFile(appDir: string, bridgePath: string, data: BridgeFile): void {
  const tmp = join(appDir, `.bridge.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, bridgePath);
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
 *
 * Token lifecycle is pid-aware, keyed off any pre-existing bridge.json:
 *  - LIVE pid  → a bridge is already serving this vault; REFUSE to start (do
 *    not clobber its discovery file — a client is pointed at it).
 *  - DEAD pid  → a prior serve exited; REUSE its token by default (session
 *    continuity), or mint a fresh one under `--rotate-token` (revocation).
 *  - no file   → mint a fresh token.
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

  const existing = readBridgeFile(bridgePath);
  if (existing && isPidAlive(existing.pid)) {
    // A bridge is already running for this vault. Refuse rather than clobber
    // its discovery file — the incumbent's client is pointed at that port.
    throw new Error(
      `a VaultLedger bridge is already running for this vault (pid ${existing.pid}, ` +
        `port ${existing.port}). Stop it first, or point your client at that port.`,
    );
  }

  // Dead-pid incumbent: reuse its token for session continuity, unless the
  // caller explicitly rotated. No incumbent (or corrupt file): mint fresh.
  const token = existing && !opts.rotateToken ? existing.token : mintToken();

  const running = await startBridge(vaultDir, {
    token,
    port: opts.port ?? 0,
    now,
    genId: opts.genId,
    env: opts.env,
  });

  const startedAt = now();
  writeBridgeFile(appDir, bridgePath, { port: running.port, token, pid: process.pid, startedAt });

  out(`VaultLedger bridge on http://127.0.0.1:${running.port} (token in ${bridgePath})`);

  let closed = false;
  let onSignal: (() => void) | undefined;

  const close = async (): Promise<void> => {
    if (closed) return;
    try {
      if (installSignalHandlers && onSignal) {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }
      await running.close();
    } finally {
      // Only remove the discovery file if it STILL describes THIS instance.
      // A newer serve may have taken over bridge.json since we started; a
      // late close() must not delete that newer instance's live file.
      try {
        const current = readBridgeFile(bridgePath);
        if (current && current.pid === process.pid && current.port === running.port) {
          unlinkSync(bridgePath);
        }
      } catch {
        // best-effort teardown: never let an unlink error mask close().
      }
      // Mark closed only AFTER the teardown attempt so a transient
      // running.close() failure doesn't permanently wedge a retry.
      closed = true;
    }
  };

  if (installSignalHandlers) {
    onSignal = (): void => {
      // Even if close() rejects, still exit (non-zero) rather than leaving an
      // unhandled rejection to crash the process obscurely.
      void close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }

  return { port: running.port, token, bridgePath, close };
}
