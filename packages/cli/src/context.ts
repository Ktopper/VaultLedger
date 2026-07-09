import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import * as YAML from "yaml";
import {
  Approvals,
  Broker,
  BrokerError,
  Journal,
  LedgerGit,
  MemoryStore,
  PermissionsManifest,
  ensureJournal,
  journalPath,
  openJournal,
  permissionsPath,
  readConfig,
  reconcile,
  vaultLockDir,
  type LedgerConfig,
} from "@vaultledger/core";

export interface LedgerContext {
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
  /** Directory the cross-process vault mutation lock is rooted at (see core's
   * vaultLockDir). Threaded into the Broker AND exposed here so mutating
   * commands that don't go through the Broker — notably `ledger undo`, whose
   * undoTransaction/undoSession take their own lockDir — participate in the
   * same cross-process mutual exclusion. */
  lockDir: string;
  /** The typed as the return of `openJournal` rather than importing
   * `better-sqlite3` directly — the CLI stays a thin adapter over core's own
   * dependency, with no type dependency of its own to manage. */
  db: ReturnType<typeof openJournal>;
}

export interface LoadContextDeps {
  now?: () => string;
  genId?: (prefix: string) => string;
  env?: NodeJS.ProcessEnv;
  /** Skip the startup `ensureJournal` auto-heal walk. Set by `reindex`, which
   * does its own full disk+git walk immediately after loading — running
   * ensureJournal first would walk the vault twice for no benefit. */
  skipEnsure?: boolean;
}

/** Real, collision-safe id generator: `<prefix>_<8 hex chars>`. Tests inject
 * their own deterministic genId via LoadContextDeps. */
function defaultGenId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

const NOT_INITIALIZED_MESSAGE = "not a VaultLedger vault (run `ledger init` first)";
const PERMISSIONS_BROKEN_MESSAGE =
  "permissions file missing or corrupt (run `ledger init` to repair)";

/**
 * Build the full set of core objects a CLI command needs, from a vault root
 * on disk. Thin orchestration only: reads config + permissions, opens the
 * journal, wires Broker/MemoryStore/Approvals, then runs the startup
 * auto-heal (ensureJournal) and crash-recovery (reconcile) — both of which
 * only ever write the disposable journal DB, never the vault or git.
 *
 * The TTL sweep is deliberately NOT run here: sweep mutates the vault
 * (forget archives files + commits), so running it on every CLI invocation
 * would make read-only commands (`status`, `log`) silently write to git. In
 * v0.1 the sweep runs at MCP-server startup instead.
 *
 * Callers must call `db.close()` when done.
 */
export async function loadContext(
  vaultRoot: string,
  deps?: LoadContextDeps,
): Promise<LedgerContext> {
  let config: LedgerConfig;
  try {
    config = readConfig(vaultRoot);
  } catch (e) {
    if (e instanceof BrokerError && e.code === "NOT_FOUND") {
      throw new Error(NOT_INITIALIZED_MESSAGE);
    }
    throw e;
  }

  // Guard the whole permissions read (ENOENT from readFileSync, a YAML syntax
  // error, or a zod validation failure) behind one friendly message rather
  // than surfacing a raw stack — a config.json without a valid permissions.yaml
  // is a broken/half-initialized vault the user can repair via `ledger init`.
  let manifest: PermissionsManifest;
  try {
    const manifestRaw = readFileSync(permissionsPath(vaultRoot), "utf8");
    manifest = PermissionsManifest.parse(YAML.parse(manifestRaw));
  } catch {
    throw new Error(PERMISSIONS_BROKEN_MESSAGE);
  }

  const now = deps?.now ?? (() => new Date().toISOString());
  const genId = deps?.genId ?? defaultGenId;

  const dbPath = journalPath(config.vaultId, deps?.env);
  // journalPath lives under the OS app-support dir (or a temp HOME injected
  // by tests via deps.env), which may not exist yet for a brand-new vaultId
  // — openJournal itself does not create parent directories.
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openJournal(dbPath);

  // Everything after the handle is open must run inside this guard: if
  // ensureJournal/reconcile throws, the caller never receives a context and so
  // never runs its own `finally { db.close() }`, leaking the sqlite fd.
  try {
    const journal = new Journal(db);
    const git = new LedgerGit(vaultRoot);
    // Same lockDir every host wired against this vaultId must use (see
    // core's openVault/vaultLockDir) — this is what makes `ledger serve`/CLI
    // mutations mutually exclusive with the MCP server's.
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

    if (!deps?.skipEnsure) {
      await ensureJournal({ vaultRoot, git, journal, now, genId });
    }
    await reconcile({ git, journal, now, genId });

    return { vaultRoot, config, manifest, journal, git, broker, store, approvals, now, genId, lockDir, db };
  } catch (e) {
    db.close();
    throw e;
  }
}
