import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
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
  db: Database.Database;
}

export interface LoadContextDeps {
  now?: () => string;
  genId?: (prefix: string) => string;
  env?: NodeJS.ProcessEnv;
  /** Skip the startup TTL sweep (e.g. for commands that don't need it, or in
   * tests that want to inspect scratch memories before they age out). */
  skipSweep?: boolean;
}

/** Real, collision-safe id generator: `<prefix>_<8 hex chars>`. Tests inject
 * their own deterministic genId via LoadContextDeps. */
function defaultGenId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

const NOT_INITIALIZED_MESSAGE = "not a VaultLedger vault (run `ledger init` first)";

/**
 * Build the full set of core objects a CLI command needs, from a vault root
 * on disk. Thin orchestration only: reads config + permissions, opens the
 * journal, wires Broker/MemoryStore/Approvals, then runs the startup
 * auto-heal (ensureJournal), crash-recovery (reconcile), and TTL sweep passes
 * before handing the context back. Callers must call `db.close()` when done.
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

  const manifestRaw = readFileSync(permissionsPath(vaultRoot), "utf8");
  const manifest = PermissionsManifest.parse(YAML.parse(manifestRaw));

  const now = deps?.now ?? (() => new Date().toISOString());
  const genId = deps?.genId ?? defaultGenId;

  const dbPath = journalPath(config.vaultId, deps?.env);
  const db = openJournal(dbPath);
  const journal = new Journal(db);

  const git = new LedgerGit(vaultRoot);
  const broker = new Broker({
    vaultRoot,
    git,
    journal,
    manifest,
    now,
    genId,
    patchThreshold: config.patchThreshold,
  });
  const store = new MemoryStore({ broker, journal, now, genId, vaultRoot });
  const approvals = new Approvals({ broker, journal, store, now });

  await ensureJournal({ vaultRoot, git, journal, now, genId });
  await reconcile({ git, journal, now, genId });
  if (!deps?.skipSweep) {
    await sweep({
      store,
      journal,
      now,
      ttlDays: config.ttlDays,
      stalenessDays: config.stalenessDays,
    });
  }

  return { vaultRoot, config, manifest, journal, git, broker, store, approvals, now, genId, db };
}
