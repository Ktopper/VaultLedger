import lockfile from "proper-lockfile";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Cross-process vault mutation lock (design v0.2 §1.2). Every mutating
 * broker/undo operation acquires this lock so `ledger serve` and the MCP
 * server never write the vault (files + git + journal) at the same time.
 *
 * Staleness-safe by construction: `update` (how often the lock's mtime is
 * refreshed while held) is kept far BELOW `stale` (how old an unrefreshed
 * lock must be before another process is allowed to steal it). That gap is
 * what keeps a slow-but-alive holder (e.g. mid `git commit`) from being
 * declared abandoned and having its lock stolen out from under it.
 */
const LOCK_OPTS = {
  stale: 20000,
  update: 2000,
  retries: { retries: 50, factor: 1.5, minTimeout: 50, maxTimeout: 1000 },
} as const;

/**
 * Run `fn` while holding the exclusive vault mutation lock rooted at
 * `lockDir` (a per-vault directory — see `vaultLockDir`). Blocks (retrying
 * per `LOCK_OPTS.retries`) until the lock is acquired, then always releases
 * it afterward, even if `fn` throws.
 */
export async function withVaultLock<T>(lockDir: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(lockDir, { recursive: true });
  const target = join(lockDir, "vault");
  const release = await lockfile.lock(target, { ...LOCK_OPTS, realpath: false });
  try {
    return await fn();
  } finally {
    await release();
  }
}

export const LOCK_CONFIG = LOCK_OPTS;

/**
 * Explicit opt-out sentinel for `Broker`'s and undo's `lockDir` (VL-SEC-S1-01).
 * `lockDir` is a REQUIRED option on both — an embedder must either pass a
 * real lock directory or this sentinel, so constructing an unlocked broker
 * against a shared vault can never happen by silent omission. Reserved for
 * same-process, single-writer callers (most unit tests) that don't need
 * cross-process locking; every real host (CLI, MCP server, `ledger serve`)
 * always passes a real `lockDir` from `vaultLockDir`.
 */
export const UNSAFE_NO_LOCK = "unsafe-no-lock" as const;

/** A real lock directory, or the explicit `UNSAFE_NO_LOCK` opt-out. */
export type LockDirOption = string | typeof UNSAFE_NO_LOCK;
