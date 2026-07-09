import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import * as YAML from "yaml";
import { Approvals } from "../approvals/queue.js";
import { Broker } from "../broker/broker.js";
import { LedgerGit } from "../broker/git.js";
import { reconcile } from "../broker/reconcile.js";
import { BrokerError } from "../errors.js";
import { readConfig, permissionsPath, journalPath, vaultLockDir, type LedgerConfig } from "../config.js";
import { openJournal } from "../journal/db.js";
import { Journal } from "../journal/journal.js";
import { ensureJournal } from "../memory/reindex.js";
import { sweep, type SweepResult } from "../memory/ttl.js";
import { MemoryStore } from "../memory/store.js";
import { PermissionsManifest } from "../schemas/manifest.js";

export interface VaultContext {
  vaultRoot: string;
  config: LedgerConfig;
  manifest: PermissionsManifest;
  journal: Journal;
  git: LedgerGit;
  broker: Broker;
  store: MemoryStore;
  approvals: Approvals;
  now: () => string;
  genId: (prefix: string) => string;
  /** This host's session id, threaded through mutations for attribution
   * (CLAUDE.md: "every mutation must be attributable: session, reason,
   * commit"). */
  session: string;
  /** Directory the cross-process vault mutation lock is rooted at (see
   * concurrency/lock.ts / vaultLockDir) — the SAME lockDir every host
   * (`ledger serve`, the MCP server, a future CLI-via-openVault caller)
   * pointed at this vaultId must use, so their mutations mutually exclude. */
  lockDir: string;
  /** The typed as the return of `openJournal` rather than importing
   * `better-sqlite3` directly. */
  db: ReturnType<typeof openJournal>;
  /** Close the underlying journal db handle. Idempotent per better-sqlite3's
   * own `close()` semantics is NOT guaranteed — call at most once. */
  close(): void;
}

export interface OpenVaultDeps {
  now?: () => string;
  genId?: (prefix: string) => string;
  env?: NodeJS.ProcessEnv;
  /** This host's session id. Defaults to a real generated session
   * (`host-<iso-date>-<rand>`); tests inject a deterministic one. */
  session?: string;
  /** Run the TTL sweep once at open (mutates the vault: archives expired
   * scratch memories). Defaults to false — a caller that opens a vault for a
   * quick read-only operation should not silently write to git. */
  sweep?: boolean;
}

/** Real, collision-safe id generator: `<prefix>_<8 hex chars>`. Tests inject
 * their own deterministic genId via OpenVaultDeps. */
function defaultGenId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/** Real per-process session id. Tests inject their own via OpenVaultDeps. */
function defaultSession(): string {
  return `host-${new Date().toISOString()}-${randomUUID().replace(/-/g, "").slice(0, 6)}`;
}

const NOT_INITIALIZED_MESSAGE = "not a VaultLedger vault (run `ledger init` first)";
const PERMISSIONS_BROKEN_MESSAGE =
  "permissions file missing or corrupt (run `ledger init` to repair)";

/**
 * Build the full set of core objects a host (the Obsidian plugin's `ledger
 * serve` backend, the MCP server, or any future embedder) needs, from a
 * vault root on disk — the single wiring path every host should converge on
 * so the cross-process vault lock (concurrency/lock.ts) is ALWAYS threaded
 * through the Broker consistently. Mirrors `packages/cli/src/context.ts`'s
 * `loadContext`, plus:
 *
 *  - computes `lockDir` (vaultLockDir(config.vaultId, env)) and passes it
 *    into the Broker so every mutation acquires the shared lock;
 *  - generates a `session` id for this host (real default, injectable);
 *  - optionally runs the TTL sweep at open (opt-in via `sweep: true`).
 *
 * Everything after the journal handle is opened runs inside a try/catch that
 * closes `db` before rethrowing (a known fix carried over from the CLI/MCP
 * context loaders) so a startup failure never leaks the sqlite fd.
 *
 * Callers must call `close()` when done.
 */
export async function openVault(vaultRoot: string, deps?: OpenVaultDeps): Promise<VaultContext> {
  let config: LedgerConfig;
  try {
    config = readConfig(vaultRoot);
  } catch (e) {
    if (e instanceof BrokerError && e.code === "NOT_FOUND") {
      throw new Error(NOT_INITIALIZED_MESSAGE);
    }
    throw e;
  }

  let manifest: PermissionsManifest;
  try {
    const manifestRaw = readFileSync(permissionsPath(vaultRoot), "utf8");
    manifest = PermissionsManifest.parse(YAML.parse(manifestRaw));
  } catch {
    throw new Error(PERMISSIONS_BROKEN_MESSAGE);
  }

  const now = deps?.now ?? (() => new Date().toISOString());
  const genId = deps?.genId ?? defaultGenId;
  const session = deps?.session ?? defaultSession();

  const dbPath = journalPath(config.vaultId, deps?.env);
  // journalPath lives under the OS app-support dir (or a temp HOME injected
  // by tests via deps.env), which may not exist yet for a brand-new vaultId
  // — openJournal itself does not create parent directories.
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openJournal(dbPath);

  try {
    const journal = new Journal(db);
    const git = new LedgerGit(vaultRoot);
    const lockDir = vaultLockDir(config.vaultId, deps?.env);
    const broker = new Broker({
      vaultRoot,
      git,
      journal,
      manifest,
      now,
      genId,
      patchThreshold: config.patchThreshold,
      lockDir,
    });
    const store = new MemoryStore({ broker, journal, now, genId, vaultRoot });
    const approvals = new Approvals({ broker, journal, store, now, vaultRoot, genId });

    await ensureJournal({ vaultRoot, git, journal, now, genId });
    await reconcile({ git, journal, now, genId });

    if (deps?.sweep) {
      const sweepResult: SweepResult = await sweep({
        store,
        journal,
        now,
        ttlDays: config.ttlDays,
        stalenessDays: config.stalenessDays,
        session,
      });
      void sweepResult;
    }

    return {
      vaultRoot,
      config,
      manifest,
      journal,
      git,
      broker,
      store,
      approvals,
      now,
      genId,
      session,
      lockDir,
      db,
      close: () => db.close(),
    };
  } catch (e) {
    db.close();
    throw e;
  }
}
