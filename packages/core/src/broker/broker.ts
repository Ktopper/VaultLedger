import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, dirname } from "node:path";
import { BrokerError } from "../errors.js";
import type { PermissionsManifest } from "../schemas/manifest.js";
import type { ProposedOperation } from "../schemas/operation.js";
import type { ApprovalRow, Journal, TransactionRow } from "../journal/journal.js";
import { resolveZone } from "../zones.js";
import { assertHashFormat, hashBytes, hashFile } from "./hash.js";
import { applyPatch, assertPatchParseable } from "./patch.js";
import { assertStructurePreserved, governedProvenanceChanged } from "./lint.js";
import { assertContainedAndReadable, writeContainedFile } from "./containment.js";
import { formatMessage, type LedgerGit } from "./git.js";
import { UNSAFE_NO_LOCK, withVaultLock, type LockDirOption } from "../concurrency/lock.js";

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
  /** Every mutating broker operation (apply's create/revise/propose_edit and
   * archive) acquires the shared cross-process vault lock rooted at this
   * directory (see concurrency/lock.ts) before running its body. REQUIRED
   * (VL-SEC-S1-01): an embedder must either pass a real lock directory or
   * the explicit `UNSAFE_NO_LOCK` sentinel — a Broker can no longer be
   * constructed unlocked by silent omission. Every real host (CLI, MCP
   * server, `ledger serve`) passes a real `lockDir` from `vaultLockDir`;
   * `UNSAFE_NO_LOCK` is for same-process, single-writer tests only. */
  lockDir: LockDirOption;
}

type CreateOp = Extract<ProposedOperation, { op: "create" }>;
type ReviseOp = Extract<ProposedOperation, { op: "revise" }>;
type ProposeEditOp = Extract<ProposedOperation, { op: "propose_edit" }>;

/**
 * The single gate every vault write passes through (design §5). Every
 * rejection is a thrown BrokerError — callers that want a plain object call
 * `.toRejection()` themselves. `promote`/`forget`/`distill`/`retire` are NOT
 * handled by `apply()`: those operate on a memory id (or, for `distill`, a
 * set of source memory ids), not a path, and are the memory store's job to
 * resolve into a path before calling `archive()` (forget) or a plain journal
 * update (promote) or a validated `create()` (distill) or an approved
 * frontmatter `revise()` (retire). Calling `apply()` with any of them throws.
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
    this.lockDir = opts.lockDir === UNSAFE_NO_LOCK ? undefined : opts.lockDir;
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
        case "distill":
        case "retire":
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
    // VL-SEC-S1-02: re-verify containment and write via temp+rename (not a
    // direct writeFileSync(toAbs, ...), which would follow a symlink swapped
    // in at toAbs) — see containment.ts's writeContainedFile for why.
    writeContainedFile(this.vaultRoot, this.manifest, toRel, content);
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
    // VL-SEC-S1-02: re-verify containment and write via temp+rename rather
    // than a direct writeFileSync(abs, ...) — see writeContainedFile.
    writeContainedFile(this.vaultRoot, this.manifest, op.path, contentBuf);

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

    // Format guard (MALFORMED_HASH) before existsSync/hash compare: reject a
    // malformed expected_hash (e.g. a bare hex digest missing the `sha256:`
    // prefix) immediately rather than letting it fall through to a
    // confusing, delayed STALE_HASH. Normalize to lowercase so an
    // uppercase-but-correct hash still matches the lowercase-computed digest
    // below.
    const expectedHash = assertHashFormat(op.expected_hash);

    if (!existsSync(abs)) {
      throw new BrokerError("NOT_FOUND", `target not found: ${op.path}`);
    }

    // VL-SEC-S1-01: this hash read and the write below are covered by the
    // caller-held vault lock (see apply()'s withVaultLock wrap) when a real
    // lockDir was supplied, closing the check-write TOCTOU across processes;
    // see writeContainedFile below for the same-window symlink-swap defense.
    const computed = hashFile(abs);
    if (computed !== expectedHash) {
      throw new BrokerError(
        "STALE_HASH",
        `expected hash ${expectedHash}, found ${computed} for ${op.path}`,
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
    //
    // VL-SEC-S2-03: bare `approved` is NOT a sound discriminator for skipping
    // this guard -- `approved:true` is set by TWO distinct kinds of caller:
    // (1) internal privileged status flips (flipFrontmatterStatus in
    // store.ts, backfillEntity.ts, and this file's own test fixtures), which
    // pass approved:true WITHOUT an approvalId, and (2) the generic
    // human-approved-via-queue path (Approvals.dispatchApply, queue.ts),
    // which is the ONLY caller that passes approvalId ALONGSIDE approved:true
    // -- approvalId is server-`genId`'d, never sourced from agent/human JSON,
    // so its presence is an unforgeable signal of which caller this is. Only
    // (1) may bypass the guard: a generically-approved revise's patch text is
    // exactly the untrusted, potentially-lying input VL-SEC-S2-01 guards
    // against (a hunk whose declared position and actual landing differ), and
    // the human approving it has no way to independently verify the diff
    // they were shown matches its actual effect. Skipping the guard there
    // would let an approved "body wording tweak" silently rewrite
    // ledger.status/supersedes/entity underneath the approving human.
    const internal = approved && approvalId == null;
    if (!internal && governedProvenanceChanged(before, after)) {
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

    // VL-SEC-S1-02: this is the window a concurrent process can win — real
    // async work sits between the containment check at the top of this
    // method and here (patch apply, the `await` above for fileAtHead, a
    // possible baseline commit), long enough for another process to swap
    // `op.path` for a symlink pointing outside the vault. writeContainedFile
    // re-runs the full realpath containment check with ZERO await between
    // that check and the write, then writes via temp-file+renameSync (which
    // does not follow a symlink at the destination) instead of a direct
    // writeFileSync(abs, ...) reusing the now-possibly-stale `abs` computed
    // above. See containment.ts for the full defense + documented residual.
    writeContainedFile(this.vaultRoot, this.manifest, op.path, after);

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

    // Format guard (MALFORMED_HASH) before it enqueues: a malformed
    // expected_hash (e.g. a bare hex digest missing the `sha256:` prefix)
    // must never enter the approval queue, where it would only surface as a
    // confusing STALE_HASH at approve-time. Normalize to lowercase and store
    // that normalized value in the held op so an uppercase-but-correct hash
    // still matches at approve-time. Checked after the zone/containment
    // guards above so a forbidden/escaping path still surfaces its own
    // FORBIDDEN_ZONE, matching applyRevise's ordering.
    const expectedHash = assertHashFormat(op.expected_hash);
    const normalizedOp: ProposeEditOp = { ...op, expected_hash: expectedHash };

    // Parse-validate the patch BEFORE it enqueues — an unapplyable patch (V4A /
    // `*** Begin Patch`) must never enter the queue only to fail at every
    // approval surface. retriable:true so the agent can fix-and-retry; apply-time
    // keeps the default false (a human at the approval surface can't fix by
    // retrying). Same SYNTAX_BREAK code both sites (defense in depth — the queue
    // can hold pre-fix proposals; the applier never assumes propose validated).
    assertPatchParseable(op.patch, true);

    const approvalId = this.genId("apr");
    const row: ApprovalRow = {
      id: approvalId,
      held_operation: JSON.stringify(normalizedOp),
      zone,
      reason: op.reason,
      session: op.session,
      state: "pending",
      created_at: this.now(),
      resolved_at: null,
      stale_reason: null,
    };
    this.journal.insertApproval(row);

    return { ok: true, queued: true, approvalId };
  }
}
