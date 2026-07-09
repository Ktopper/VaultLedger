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
  sweep,
  vaultLockDir,
  type LedgerConfig,
  type SweepResult,
} from "@vaultledger/core";

export interface ServerContext {
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
  /** The MCP server's session id, threaded through every mutating tool call
   * (design: session is server-scoped, not a per-call tool argument). */
  session: string;
  /** The typed as the return of `openJournal` rather than importing
   * `better-sqlite3` directly — the MCP server stays a thin adapter over
   * core's own dependency, with no type dependency of its own to manage. */
  db: ReturnType<typeof openJournal>;
}

export interface LoadServerContextDeps {
  now?: () => string;
  genId?: (prefix: string) => string;
  env?: NodeJS.ProcessEnv;
  session?: string;
}

/** Real, collision-safe id generator: `<prefix>_<8 hex chars>`. Tests inject
 * their own deterministic genId via LoadServerContextDeps. */
function defaultGenId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/** Real per-process session id: `mcp-<iso-date>-<rand>`. Tests inject their
 * own deterministic session via LoadServerContextDeps. */
function defaultSession(): string {
  return `mcp-${new Date().toISOString()}-${randomUUID().replace(/-/g, "").slice(0, 6)}`;
}

const NOT_INITIALIZED_MESSAGE = "not a VaultLedger vault (run `ledger init` first)";
const PERMISSIONS_BROKEN_MESSAGE =
  "permissions file missing or corrupt (run `ledger init` to repair)";

/**
 * Surface the startup TTL sweep's outcome (design: the MCP server IS the
 * review layer, and CLAUDE.md's auditability rule means a sweep that
 * archived, flagged, failed, or found malformed memories must not vanish
 * silently). Written to STDERR only — stdout is the JSON-RPC transport and
 * must never carry human-readable diagnostics. Stays quiet when the sweep
 * was a complete no-op so a clean startup produces no noise.
 */
function reportSweep(result: SweepResult): void {
  const { archived, staleFlagged, failed, malformed } = result;
  if (
    archived.length === 0 &&
    staleFlagged.length === 0 &&
    failed.length === 0 &&
    malformed.length === 0
  ) {
    return;
  }
  console.error(
    `vaultledger: TTL sweep — archived ${archived.length}, staleFlagged ${staleFlagged.length}, ` +
      `failed ${failed.length}, malformed ${malformed.length}`,
  );
}

/**
 * Build the full set of core objects the MCP server needs, from a vault root
 * on disk. Thin orchestration only: reads config + permissions, opens the
 * journal, wires Broker/MemoryStore/Approvals, then runs the startup
 * auto-heal (ensureJournal), crash-recovery (reconcile), AND the TTL sweep.
 *
 * Unlike the CLI's `loadContext` (which deliberately skips the sweep so
 * read-only commands never mutate the vault), the MCP server is a
 * long-running session started once per agent conversation — design §6 calls
 * for the sweep to run at MCP-server startup, so it runs here.
 *
 * Callers must call `db.close()` when done.
 */
export async function loadServerContext(
  vaultRoot: string,
  deps?: LoadServerContextDeps,
): Promise<ServerContext> {
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
  const session = deps?.session ?? defaultSession();

  const dbPath = journalPath(config.vaultId, deps?.env);
  // journalPath lives under the OS app-support dir (or a temp HOME injected
  // by tests via deps.env), which may not exist yet for a brand-new vaultId
  // — openJournal itself does not create parent directories.
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openJournal(dbPath);

  // Everything after the handle is open must run inside this guard: if
  // ensureJournal/reconcile/sweep throws, the caller never receives a context
  // and so never runs its own `finally { db.close() }`, leaking the sqlite fd.
  try {
    const journal = new Journal(db);
    const git = new LedgerGit(vaultRoot);
    // Same lockDir every host wired against this vaultId must use (see
    // core's openVault/vaultLockDir) — this is what makes the MCP server's
    // mutations mutually exclusive with `ledger serve`/the CLI's.
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
    const sweepResult = await sweep({
      store,
      journal,
      now,
      ttlDays: config.ttlDays,
      stalenessDays: config.stalenessDays,
      session,
    });
    reportSweep(sweepResult);

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
      db,
    };
  } catch (e) {
    db.close();
    throw e;
  }
}
