import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { BrokerError } from "../errors.js";
import type { PermissionsManifest } from "../schemas/manifest.js";
import type { ProposedOperation } from "../schemas/operation.js";
import type { ApprovalRow, Journal, TransactionRow } from "../journal/journal.js";
import { resolveZone } from "../zones.js";
import { hashBytes, hashFile } from "./hash.js";
import { applyPatch } from "./patch.js";
import { assertStructurePreserved, governedProvenanceChanged } from "./lint.js";
import { assertContainedAndReadable } from "./containment.js";
import { formatMessage, type LedgerGit } from "./git.js";
import { withVaultLock } from "../concurrency/lock.js";

const DEFAULT_PATCH_THRESHOLD = 0.5;

/** Result of a write that landed immediately (create/revise/archive). */
export interface AppliedResult {
  ok: true;
  queued?: false;
  txnId?: string;
  commitSha?: string;
  memoryId?: string;
  path?: string;
}

/** Result of a propose_edit that was queued for approval instead of applied. */
export interface QueuedResult {
  ok: true;
  queued: true;
  approvalId: string;
}

export type ApplyResult = AppliedResult | QueuedResult;

export interface BrokerOptions {
  vaultRoot: string;
  git: LedgerGit;
  journal: Journal;
  manifest: PermissionsManifest;
  now: () => string;
  genId: (prefix: string) => string;
  patchThreshold?: number;
  /** When set, every mutating broker operation (apply's create/revise/
   * propose_edit and archive) acquires the shared cross-process vault lock
   * rooted at this directory (see concurrency/lock.ts) before running its
   * body. Opt-in: unset (the v0.1 default) leaves behavior byte-for-byte
   * unchanged — no lock acquired, no lockfile created — so every existing
   * single-process caller/test is unaffected. */
  lockDir?: string;
}

type CreateOp = Extract<ProposedOperation, { op: "create" }>;
type ReviseOp = Extract<ProposedOperation, { op: "revise" }>;
type ProposeEditOp = Extract<ProposedOperation, { op: "propose_edit" }>;

/**
 * The single gate every vault write passes through (design §5). Every
 * rejection is a thrown BrokerError — callers that want a plain object call
 * `.toRejection()` themselves. `promote`/`forget` are NOT handled by
 * `apply()`: those operate on a memory id, not a path, and are the memory
 * store's job to resolve into a path before calling `archive()` (forget) or
 * a plain journal update (promote). Calling `apply()` with either throws.
 */
export class Broker {
  private readonly vaultRoot: string;
  private readonly git: LedgerGit;
  private readonly journal: Journal;
  private readonly manifest: PermissionsManifest;
  private readonly now: () => string;
  private readonly genId: (prefix: string) => string;
  private readonly patchThreshold: number;
  private readonly lockDir: string | undefined;

  constructor(opts: BrokerOptions) {
    this.vaultRoot = opts.vaultRoot;
    this.git = opts.git;
    this.journal = opts.journal;
    this.manifest = opts.manifest;
    this.now = opts.now;
    this.genId = opts.genId;
    this.patchThreshold = opts.patchThreshold ?? DEFAULT_PATCH_THRESHOLD;
    this.lockDir = opts.lockDir;
  }

  async apply(
    op: ProposedOperation,
    opts?: { approved?: boolean; approvalId?: string },
  ): Promise<ApplyResult> {
    // approvalId: when this apply is the deferred execution of a held approval
    // (Approvals.approve re-runs the held op through here), it stamps the
    // resulting transaction row with the originating approval's id so
    // reconcile can SOUNDLY close a stale pending approval by exact id-match.
    // Unset for every direct broker write → the row's approval_id stays null.
    const approvalId = opts?.approvalId ?? null;
    const run = async (): Promise<ApplyResult> => {
      switch (op.op) {
        case "create":
          return this.applyCreate(op, approvalId);
        case "revise":
          return this.applyRevise(op, opts?.approved ?? false, approvalId);
        case "propose_edit":
          return this.applyProposeEdit(op);
        case "promote":
        case "forget":
          throw new BrokerError(
            "NOT_FOUND",
            `op '${op.op}' operates on a memory id and must be resolved to a path by the ` +
              `memory store before reaching the broker (use Broker.archive() for forget)`,
          );
        default: {
          const exhaustive: never = op;
          throw new BrokerError("SYNTAX_BREAK", `unknown op: ${JSON.stringify(exhaustive)}`);
        }
      }
    };
    if (this.lockDir !== undefined) {
      return withVaultLock(this.lockDir, run);
    }
    return run();
  }

  /**
   * Move a file from one vault-relative path to another and commit the move
   * (delete + add) as a single ledger commit. Used by the memory store's
   * forget flow to archive a memory file. Not part of `apply()` because
   * `forget` operates on a memory id at the store layer, not a path.
   */
  async archive(
    fromRel: string,
    toRel: string,
    session: string,
    reason: string,
  ): Promise<AppliedResult> {
    const run = async (): Promise<AppliedResult> => this.doArchive(fromRel, toRel, session, reason);
    if (this.lockDir !== undefined) {
      return withVaultLock(this.lockDir, run);
    }
    return run();
  }

  private async doArchive(
    fromRel: string,
    toRel: string,
    session: string,
    reason: string,
  ): Promise<AppliedResult> {
    // ALL containment + zone checks run BEFORE any fs mutation (writeFile /
    // unlink happen before the git commit, so a late rejection would leave a
    // half-applied move on disk). Both endpoints must stay inside the vault
    // AND resolve to a writable zone (agent/scratch); the archive destination
    // Agent/Archive/** is agent zone. Excluded/trusted are rejected.
    const fromAbs = this.resolveAbs(fromRel);
    const toAbs = this.resolveAbs(toRel);

    const fromZone = resolveZone(fromRel, this.manifest);
    if (fromZone !== "agent" && fromZone !== "scratch") {
      throw new BrokerError(
        "FORBIDDEN_ZONE",
        `archive source must be in agent/scratch zone (was '${fromZone}'): ${fromRel}`,
      );
    }
    const toZone = resolveZone(toRel, this.manifest);
    if (toZone !== "agent" && toZone !== "scratch") {
      throw new BrokerError(
        "FORBIDDEN_ZONE",
        `archive destination must be in agent/scratch zone (was '${toZone}'): ${toRel}`,
      );
    }

    if (!existsSync(fromAbs)) {
      throw new BrokerError("NOT_FOUND", `archive source not found: ${fromRel}`);
    }
    if (existsSync(toAbs)) {
      throw new BrokerError("TARGET_EXISTS", `archive target already exists: ${toRel}`);
    }

    const content = readFileSync(fromAbs);
    mkdirSync(dirname(toAbs), { recursive: true });
    writeFileSync(toAbs, content);
    unlinkSync(fromAbs);

    const message = formatMessage({ op: "forget", basename: basename(fromRel), session });
    const commitSha = await this.git.commitPaths([fromRel, toRel], message);

    const txnId = this.genId("txn");
    const txn: TransactionRow = {
      id: txnId,
      op: "forget",
      path: fromRel,
      hash_before: hashBytes(content),
      hash_after: null,
      session,
      reason,
      memory_id: null,
      commit_sha: commitSha,
      approval_id: null,
      created_at: this.now(),
      status: "applied",
    };
    this.journal.recordTransaction(txn);

    return { ok: true, txnId, commitSha, path: toRel };
  }

  /**
   * Resolve a vault-relative path to an absolute path AND enforce that it
   * stays inside the vault root AND is not in the excluded zone. Every
   * filesystem access in the broker (create, revise, propose_edit, archive)
   * routes through here. Delegates to the shared `assertContainedAndReadable`
   * helper (containment.ts) so the server's read-only `/provenance` route
   * enforces the EXACT same trust boundary rather than a second
   * implementation that could drift out of sync. On escape/excluded we
   * throw FORBIDDEN_ZONE (see containment.ts for the two containment
   * layers this performs).
   */
  private resolveAbs(relPath: string): string {
    return assertContainedAndReadable(this.vaultRoot, this.manifest, relPath);
  }

  private async applyCreate(op: CreateOp, approvalId: string | null): Promise<AppliedResult> {
    // Containment check first (throws FORBIDDEN_ZONE on a traversal escape),
    // then the zone gate — both before any filesystem mutation.
    const abs = this.resolveAbs(op.path);

    const zone = resolveZone(op.path, this.manifest);
    if (zone !== "agent" && zone !== "scratch") {
      throw new BrokerError("FORBIDDEN_ZONE", `cannot create in zone '${zone}': ${op.path}`);
    }

    if (existsSync(abs)) {
      throw new BrokerError("TARGET_EXISTS", `target already exists: ${op.path}`);
    }

    const contentBuf = Buffer.from(op.content, "utf8");
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contentBuf);

    const message = formatMessage({
      op: "create",
      basename: basename(op.path),
      session: op.session,
    });
    const commitSha = await this.git.commitFile(op.path, message);

    const txnId = this.genId("txn");
    const txn: TransactionRow = {
      id: txnId,
      op: "create",
      path: op.path,
      hash_before: null,
      hash_after: hashBytes(contentBuf),
      session: op.session,
      reason: op.reason,
      memory_id: null,
      commit_sha: commitSha,
      approval_id: approvalId,
      created_at: this.now(),
      status: "applied",
    };
    this.journal.recordTransaction(txn);

    return { ok: true, txnId, commitSha, path: op.path };
  }

  private async applyRevise(
    op: ReviseOp,
    approved: boolean,
    approvalId: string | null,
  ): Promise<AppliedResult> {
    // Containment check first: an escaping path is invalid regardless of zone,
    // and this must reject BEFORE the trusted/approval branch so a traversal
    // surfaces as FORBIDDEN_ZONE (not APPROVAL_REQUIRED).
    const abs = this.resolveAbs(op.path);

    const zone = resolveZone(op.path, this.manifest);
    if (zone === "excluded") {
      throw new BrokerError("FORBIDDEN_ZONE", `cannot revise excluded path: ${op.path}`);
    }
    if (zone === "trusted" && !approved) {
      throw new BrokerError(
        "APPROVAL_REQUIRED",
        `direct revise into trusted zone requires approval (use propose_edit): ${op.path}`,
      );
    }
    if (zone !== "agent" && zone !== "scratch" && zone !== "trusted") {
      // defensive: guards against a future 5th ZoneName being added.
      throw new BrokerError("FORBIDDEN_ZONE", `cannot revise in zone '${zone}': ${op.path}`);
    }

    if (!existsSync(abs)) {
      throw new BrokerError("NOT_FOUND", `target not found: ${op.path}`);
    }

    // v0.1 TOCTOU gap: the file could change on disk between this hash read
    // and the writeFileSync below. Acceptable for v0.1 (single-writer broker);
    // a future version may hold a lock or re-check under the git commit.
    const computed = hashFile(abs);
    if (computed !== op.expected_hash) {
      throw new BrokerError(
        "STALE_HASH",
        `expected hash ${op.expected_hash}, found ${computed} for ${op.path}`,
      );
    }

    const before = readFileSync(abs, "utf8");
    const after = applyPatch(before, op.patch, this.patchThreshold);
    assertStructurePreserved(before, after);

    // Provenance tamper guard (v0.3a): status/supersedes (in the ledger:
    // block) AND the top-level entity are governed provenance fields --
    // promote/forget/setStatus are the only legitimate way to change status,
    // and every legitimate provenance write calls apply() with approved:true.
    // An unapproved revise (the only path an agent-zone memory_revise can
    // reach) must not be able to silently rewrite them (self-promote to
    // canonical, fake a supersedes lineage, or drop a belief from every
    // same-entity comparison set by rewriting/removing entity).
    if (!approved && governedProvenanceChanged(before, after)) {
      throw new BrokerError(
        "LEDGER_GUARD",
        `revise may not change governed provenance without approval — the ledger: block (status/supersedes) and the top-level entity are governed (use promote/forget/setStatus): ${op.path}`,
      );
    }

    // DATA-LOSS GUARD (baseline the pre-image): if this note has never been
    // committed to git -- a pre-existing/untracked user note on its first
    // broker edit -- commit its CURRENT pre-edit content FIRST. Otherwise the
    // edit commit below is the file's first-ever appearance in git, so undo's
    // `git revert` of it would DELETE the note and lose the pre-edit bytes
    // entirely, breaking the core rollback guarantee (README: "rollback via
    // git revert"). The baseline uses a NON-`ledger:` message so reconcile
    // never turns it into an (undoable) transaction -- it is a pure custody
    // snapshot. Idempotent: once the file is tracked at HEAD this is skipped.
    // (`create` can't hit this: it rejects a pre-existing path with
    // TARGET_EXISTS, so an undo of a create legitimately deletes the file.)
    if ((await this.git.fileAtHead(op.path)) === null) {
      await this.git.commitFile(
        op.path,
        `VaultLedger baseline: took pre-existing ${basename(op.path)} under ledger custody`,
      );
    }

    writeFileSync(abs, after, "utf8");

    const message = formatMessage({
      op: "revise",
      basename: basename(op.path),
      session: op.session,
    });
    const commitSha = await this.git.commitFile(op.path, message);

    const txnId = this.genId("txn");
    const txn: TransactionRow = {
      id: txnId,
      op: "revise",
      path: op.path,
      hash_before: computed,
      hash_after: hashBytes(Buffer.from(after, "utf8")),
      session: op.session,
      reason: op.reason,
      memory_id: null,
      commit_sha: commitSha,
      approval_id: approvalId,
      created_at: this.now(),
      status: "applied",
    };
    this.journal.recordTransaction(txn);

    return { ok: true, txnId, commitSha, path: op.path };
  }

  private applyProposeEdit(op: ProposeEditOp): QueuedResult {
    // Reject a traversal path even though propose_edit only queues (never
    // writes): the held operation is applied later, so an escaping path must
    // never enter the approval queue in the first place.
    this.resolveAbs(op.path);

    const zone = resolveZone(op.path, this.manifest);
    if (zone === "excluded") {
      throw new BrokerError(
        "FORBIDDEN_ZONE",
        `cannot propose an edit for an excluded path: ${op.path}`,
      );
    }

    const approvalId = this.genId("apr");
    const row: ApprovalRow = {
      id: approvalId,
      held_operation: JSON.stringify(op),
      zone,
      reason: op.reason,
      session: op.session,
      state: "pending",
      created_at: this.now(),
      resolved_at: null,
    };
    this.journal.insertApproval(row);

    return { ok: true, queued: true, approvalId };
  }
}
