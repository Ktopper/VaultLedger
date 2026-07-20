import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname } from "node:path";
import { BrokerError } from "../errors.js";
import type { PermissionsManifest } from "../schemas/manifest.js";
import type { ProposedOperation } from "../schemas/operation.js";
import type { ApprovalRow, Journal, TransactionRow } from "../journal/journal.js";
import { resolveZone } from "../zones.js";
import { assertHashFormat, hashBytes, hashFile } from "./hash.js";
import { applyPatch, assertPatchParseable, patchTargetKind } from "./patch.js";
import { generateCreatePatch, generateReplacementPatch } from "./replace.js";
import { assertStructurePreserved, governedProvenanceChanged } from "./lint.js";
import { assertContained, assertContainedAndReadable, writeContainedFile } from "./containment.js";
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
type ProposeReplaceOp = Extract<ProposedOperation, { op: "propose_replace" }>;
type ProposeCreateOp = Extract<ProposedOperation, { op: "propose_create" }>;
type ProposeDeleteOp = Extract<ProposedOperation, { op: "propose_delete" }>;
type ProposeMoveOp = Extract<ProposedOperation, { op: "propose_move" }>;

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
        case "propose_replace":
          return this.applyProposeReplace(op);
        case "propose_create":
          return this.applyProposeCreate(op);
        case "propose_delete":
          // Dual-mode (like `revise`): unapproved → the propose gate (enqueue);
          // approved (Approvals.approve re-runs the held op) → the real delete.
          return opts?.approved ? this.applyDelete(op, approvalId) : this.applyProposeDelete(op);
        case "propose_move":
          return opts?.approved ? this.applyMove(op, approvalId) : this.applyProposeMove(op);
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

    return this.createFile(op.path, abs, op.content, op.session, op.reason, approvalId);
  }

  /**
   * The shared file-create + commit + transaction implementation used by BOTH
   * `applyCreate` (the direct `create` op) and `applyRevise`'s apply-create
   * branch (an approved `--- /dev/null` creation proposal). Records the
   * transaction as `op:"create"` (hash_before:null) — the commit is the file's
   * first git appearance, which is exactly what makes `undo` (git revert)
   * DELETE the file. Caller has already performed containment (`abs`) and any
   * TARGET_EXISTS / zone check; this method does no zone or existence guarding.
   */
  private async createFile(
    path: string,
    abs: string,
    content: string,
    session: string,
    reason: string,
    approvalId: string | null,
  ): Promise<AppliedResult> {
    const contentBuf = Buffer.from(content, "utf8");
    // Create intermediate dirs (spec §4): writeContainedFile does NOT mkdir
    // (its temp openSync in dirname(abs) ENOENTs if the parent is absent), and
    // a creation into an absent parent (Testing/new.md, Testing/ absent) is a
    // supported case. abs is containment-verified, so dirname(abs) lands
    // strictly under the verified ancestor.
    mkdirSync(dirname(abs), { recursive: true });
    // VL-SEC-S1-02: re-verify containment and write via temp+rename rather
    // than a direct writeFileSync(abs, ...) — see writeContainedFile.
    writeContainedFile(this.vaultRoot, this.manifest, path, contentBuf);

    const message = formatMessage({
      op: "create",
      basename: basename(path),
      session,
    });
    const commitSha = await this.git.commitFile(path, message);

    const txnId = this.genId("txn");
    const txn: TransactionRow = {
      id: txnId,
      op: "create",
      path,
      hash_before: null,
      hash_after: hashBytes(contentBuf),
      session,
      reason,
      memory_id: null,
      commit_sha: commitSha,
      approval_id: approvalId,
      created_at: this.now(),
      status: "applied",
    };
    this.journal.recordTransaction(txn);

    return { ok: true, txnId, commitSha, path };
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

    // Pairing gate at apply time (spec §5): detect the diff kind BEFORE the
    // hash check (ordering pin — assertHashFormat(undefined) would otherwise
    // wrongly reject a hash-less creation). Apply RECOMPUTES from the patch and
    // never trusts the queue. retriable defaults false here (a human at the
    // approval surface can't fix by retrying).
    const parsedR = assertPatchParseable(op.patch);
    const kindR = patchTargetKind(parsedR);
    if (kindR === "delete") {
      throw new BrokerError("SYNTAX_BREAK", "file deletion is not supported", false);
    }
    if (kindR === "create") {
      // Re-assert absence under the caller-held vault lock (spec §3): a file
      // that appeared since propose is a clean conflict, never an overwrite and
      // never jsdiff's silent prepend (we always apply to "", not the file).
      if (existsSync(abs)) {
        throw new BrokerError("TARGET_EXISTS", `target appeared since propose: ${op.path}`, false);
      }
      const after = applyPatch("", op.patch, this.patchThreshold);
      // Defense in depth (matches this method's "recompute, never trust the
      // queue" contract, same posture as the S2-03 apply-time LEDGER_GUARD): the
      // propose gate already enforces Option B, but re-assert it here so a future
      // caller that hands applyRevise a creation diff carrying a `ledger:`/entity
      // block onto a fresh path (bypassing applyProposeEdit) cannot silently mint
      // governed provenance. governedProvenanceChanged is already imported.
      if (governedProvenanceChanged("", after)) {
        throw new BrokerError(
          "LEDGER_GUARD",
          `a newly created file is a plain document; governed provenance ` +
            `(a ledger: block / top-level entity) is minted by the memory tools, not by file creation: ${op.path}`,
        );
      }
      // Early return via the shared create path (txn op:"create" → undo
      // deletes). Skips the OTHER edit-only guards (assertStructurePreserved) and
      // the baseline data-loss commit — nonsensical for a file that never existed.
      return await this.createFile(op.path, abs, after, op.session, op.reason, approvalId);
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
    // never enter the approval queue in the first place. resolveAbs returns
    // the containment-verified would-be abs (the target may not exist yet — a
    // creation), used by the pairing gate below.
    const abs = this.resolveAbs(op.path);

    const zone = resolveZone(op.path, this.manifest);
    if (zone === "excluded") {
      throw new BrokerError(
        "FORBIDDEN_ZONE",
        `cannot propose an edit for an excluded path: ${op.path}`,
      );
    }

    // Parse-validate the patch BEFORE it enqueues — an unapplyable patch (V4A /
    // `*** Begin Patch`) must never enter the queue only to fail at every
    // approval surface. retriable:true so the agent can fix-and-retry; apply-time
    // keeps the default false (a human at the approval surface can't fix by
    // retrying). Same SYNTAX_BREAK code both sites (defense in depth — the queue
    // can hold pre-fix proposals; the applier never assumes propose validated).
    // Ordering pin (spec §3): parse → detect kind → THEN conditional hash. The
    // hash check MUST follow the kind branch — assertHashFormat(undefined) throws
    // MALFORMED_HASH, so a hash-less creation would be wrongly rejected if the
    // hash ran first.
    const parsed = assertPatchParseable(op.patch, true);
    const kind = patchTargetKind(parsed);

    // The pairing gate (spec §1): jsdiff silently CORRUPTS on a diff/target
    // mismatch, so an unapplyable/mismatched proposal must never queue.
    if (kind === "delete") {
      // A `+++ /dev/null` deletion would otherwise empty the note (jsdiff yields
      // ""); deletion-as-a-feature is out of scope. Retriable so the agent learns.
      throw new BrokerError(
        "SYNTAX_BREAK",
        "file deletion via vault_propose_edit is not supported",
        true,
      );
    }
    if (kind === "create") {
      if (existsSync(abs)) {
        // A creation diff onto an existing file would PREPEND — reject it.
        throw new BrokerError("TARGET_EXISTS", `creation diff, but ${op.path} already exists`, true);
      }
      if (op.expected_hash != null) {
        // Symmetric hash enforcement: a creation targets a file that does not
        // exist, so an expected_hash is a category error — reject it.
        throw new BrokerError("MALFORMED_HASH", `a creation takes no expected_hash (${op.path})`, true);
      }
      // Dry-run: a creation's output is fully determined by the patch alone —
      // prove it applies to "" now, so no unapplyable creation ever queues
      // (upgrades the invariant from "parseable" to "applyable").
      let newContent: string;
      try {
        newContent = applyPatch("", op.patch, this.patchThreshold);
      } catch {
        throw new BrokerError(
          "SYNTAX_BREAK",
          `creation patch does not apply to an empty file: ${op.path}`,
          true,
        );
      }
      // Option B (spec §4a): a `vault_propose_edit` creation is a plain document;
      // governed provenance (a `ledger:` block / top-level `entity`) is minted by
      // the memory tools, not by file creation. REUSE the guard's predicate (the
      // existing governedProvenanceChanged with an empty `before`) — not a new
      // regex — so the two definitions of "governed provenance" can never diverge.
      if (governedProvenanceChanged("", newContent)) {
        throw new BrokerError(
          "LEDGER_GUARD",
          `a newly created file is a plain document; governed provenance ` +
            `(a ledger: block / top-level entity) is minted by the memory tools, not by file creation: ${op.path}`,
          true,
        );
      }
    } else {
      // edit: the target MUST exist, and a well-formed expected_hash is required
      // (the edit path is not weakened — a hash-less edit is MALFORMED_HASH).
      if (!existsSync(abs)) {
        throw new BrokerError("NOT_FOUND", `edit diff, but ${op.path} does not exist`, true);
      }
      assertHashFormat(op.expected_hash);
    }

    // §6 canonical-path fold: store the CANONICAL (realpath-collapsed) zonePath
    // in the queued op — the same path every zone/containment decision already
    // ran on — so a `Notes/../Foo.md` propose is held and displayed as `Foo.md`,
    // matching delete/move. NOTE (intentional, harmless): the patch's own
    // +++/--- headers still carry the RAW path the agent sent; applyRevise
    // applies the patch to op.path's CONTENT (a creation to ""), never
    // re-deriving the target from the header, so the header path never matters.
    const { zonePath } = assertContained(this.vaultRoot, op.path);
    // Enqueue the normalized op. A creation stores expected_hash: undefined
    // (JSON.stringify drops it). For an edit, normalize the hash to lowercase and
    // store that so an uppercase-but-correct hash still matches at approve-time.
    const normalizedOp: ProposeEditOp = {
      ...op,
      path: zonePath,
      ...(op.expected_hash != null ? { expected_hash: assertHashFormat(op.expected_hash) } : {}),
    };

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

  /**
   * v0.4.5: structured replace. Read + hash-verify the snapshot inside the
   * vault lock, generate an EDIT diff from the exact find/replace set, then
   * feed the EXISTING applyProposeEdit (which re-checks the hash at approve).
   * The double hash check is intentional (spec §1): propose-time here (the
   * replacements matched the right snapshot) AND approve-time in applyRevise
   * (no drift during the queue wait).
   */
  private applyProposeReplace(op: ProposeReplaceOp): QueuedResult {
    // resolveAbs enforces containment AND rejects the excluded zone before any read.
    const abs = this.resolveAbs(op.path);
    if (!existsSync(abs)) {
      throw new BrokerError("NOT_FOUND", `cannot replace in ${op.path}: file does not exist`, true);
    }
    // Well-formed + normalized (lowercased). Throws MALFORMED_HASH on a bad hash.
    const expected = assertHashFormat(op.expected_hash);
    const buf = readFileSync(abs);
    if (hashBytes(buf) !== expected) {
      throw new BrokerError(
        "STALE_HASH",
        `expected_hash does not match the current ${op.path} — recompute and retry`,
      );
    }
    const patch = generateReplacementPatch(op.path, buf.toString("utf8"), op.replacements);
    return this.applyProposeEdit({
      op: "propose_edit",
      path: op.path,
      expected_hash: op.expected_hash,
      patch,
      reason: op.reason,
      session: op.session,
    });
  }

  /**
   * v0.4.5: structured creation. Generate a `/dev/null`-headed creation diff
   * and feed the EXISTING applyProposeEdit create branch, which owns the
   * TARGET_EXISTS check, the dry-run, and Option B (governed provenance in
   * `content` is rejected identically). No expected_hash (the create branch
   * forbids one).
   */
  private applyProposeCreate(op: ProposeCreateOp): QueuedResult {
    const patch = generateCreatePatch(op.path, op.content);
    return this.applyProposeEdit({
      op: "propose_edit",
      path: op.path,
      patch,
      reason: op.reason,
      session: op.session,
    });
  }

  /**
   * The delete/move SOURCE read-oracle (design §3): resolve `relPath` through
   * the SAME gate `vault_read` uses so an EXCLUDED source is INDISTINGUISHABLE
   * from a MISSING one — both throw a byte-identical retriable `NOT_FOUND` with
   * no zone vocabulary. A traversal/symlink escape stays a hard FORBIDDEN_ZONE
   * (assertContained), never a NOT_FOUND. Returns the canonical `zonePath` (for
   * the stored op), the raw `abs` (for the unlink/read), and the raw source
   * bytes (for the hash pin, the governed check, and the move write). Reads raw
   * bytes rather than delegating to `readVaultFile` deliberately: a delete/move
   * must work on a note ABOVE the read cap or a non-UTF-8 attachment, which
   * readVaultFile's FILE_TOO_LARGE / NOT_TEXT guards would wrongly block.
   */
  private readSourceOrNotFound(relPath: string): { abs: string; zonePath: string; buf: Buffer } {
    const { abs, zonePath } = assertContained(this.vaultRoot, relPath);
    if (resolveZone(zonePath, this.manifest) === "excluded") {
      throw new BrokerError("NOT_FOUND", `file not found: ${relPath}`, true);
    }
    let st;
    try {
      st = statSync(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new BrokerError("NOT_FOUND", `file not found: ${relPath}`, true);
      }
      throw e; // EACCES etc. propagate
    }
    if (!st.isFile()) {
      // A directory (or socket/fifo) is not a deletable/movable note; treat as
      // missing so the oracle stays uniform and readFileSync never EISDIRs.
      throw new BrokerError("NOT_FOUND", `file not found: ${relPath}`, true);
    }
    return { abs, zonePath, buf: readFileSync(abs) };
  }

  /**
   * v0.4.7: propose a file DELETION (propose gate). Reads the source THROUGH the
   * oracle (excluded ≡ missing → NOT_FOUND), pins the hash (drift → STALE_HASH),
   * and refuses a governed-memory note (LEDGER_GUARD → steer to the memory
   * tools). Enqueues the FULL op with only `path` canonicalized — mirror
   * applyProposeEdit's `normalizedOp` (a fresh 3-field object would drop
   * reason/session/expected_hash, which applyDelete needs).
   */
  private applyProposeDelete(op: ProposeDeleteOp): QueuedResult {
    // Oracle first — an excluded and a missing path must both throw NOT_FOUND
    // BEFORE the hash-format check, so their payloads are byte-identical.
    const { zonePath, buf } = this.readSourceOrNotFound(op.path);
    const expected = assertHashFormat(op.expected_hash);
    if (hashBytes(buf) !== expected) {
      throw new BrokerError(
        "STALE_HASH",
        `expected_hash does not match the current ${op.path} — recompute and retry`,
      );
    }
    // A note carrying governed provenance (a ledger: block / top-level entity)
    // is a memory belief; retiring it is memory_retire/memory_forget's job (it
    // tombstones the note AND updates the journal), never a raw file delete.
    // `(content, "")` detects the present→absent governed transition.
    if (governedProvenanceChanged(buf.toString("utf8"), "")) {
      throw new BrokerError(
        "LEDGER_GUARD",
        `${op.path} carries governed provenance (a ledger: block / entity) — ` +
          `retire it with memory_retire or memory_forget, not a raw vault_propose_delete`,
        true,
      );
    }
    const normalizedOp: ProposeDeleteOp = { ...op, path: zonePath, expected_hash: expected };
    const approvalId = this.genId("apr");
    const row: ApprovalRow = {
      id: approvalId,
      held_operation: JSON.stringify(normalizedOp),
      zone: resolveZone(zonePath, this.manifest),
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

  /**
   * v0.4.7: apply an approved DELETE, under the caller-held vault lock. Re-reads
   * + re-hashes (drift → STALE_HASH, gone → NOT_FOUND) — never trusts the queued
   * snapshot. B1 DATA-LOSS GUARD: baseline-commit an untracked source BEFORE the
   * destructive unlink so undo's `git revert` can restore the pre-delete bytes.
   */
  private async applyDelete(op: ProposeDeleteOp, approvalId: string | null): Promise<AppliedResult> {
    const { abs, buf } = this.readSourceOrNotFound(op.path);
    const expected = assertHashFormat(op.expected_hash);
    const before = hashBytes(buf);
    if (before !== expected) {
      throw new BrokerError(
        "STALE_HASH",
        `expected_hash does not match the current ${op.path} — recompute and retry`,
      );
    }
    // B1: if the note has never been committed (a synced-in Inbox article on its
    // first broker touch), commit its CURRENT bytes FIRST — otherwise the delete
    // commit below is the file's first-ever git appearance, so undo's revert of
    // it would leave NO content to restore (a data-loss bug). Non-`ledger:`
    // message = a pure custody snapshot reconcile never treats as a transaction.
    // Idempotent: skipped once the file is tracked at HEAD. Mirrors applyRevise.
    if ((await this.git.fileAtHead(op.path)) === null) {
      await this.git.commitFile(
        op.path,
        `VaultLedger baseline: took pre-existing ${basename(op.path)} under ledger custody`,
      );
    }
    unlinkSync(abs);
    const message = formatMessage({ op: "delete", basename: basename(op.path), session: op.session });
    const commitSha = await this.git.commitPaths([op.path], message);

    const txnId = this.genId("txn");
    const txn: TransactionRow = {
      id: txnId,
      op: "delete",
      path: op.path,
      hash_before: before,
      hash_after: null,
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

  /**
   * v0.4.7: propose a file MOVE/rename (propose gate). SOURCE = the delete gate
   * (excluded ≡ missing → NOT_FOUND; hash pin → STALE_HASH; governed → LEDGER_GUARD).
   * DESTINATION = the applyProposeEdit create-branch gate, in ORDER (S1): (1)
   * canonical zone excluded → FORBIDDEN_ZONE, checked BEFORE (2) occupancy
   * existsSync → DESTINATION_EXISTS — so an excluded destination NEVER leaks
   * whether it is occupied. Does NOT route through applyCreate/createFile (B2):
   * those are agent/scratch-only and would reject a trusted `Clients/Brandit` move.
   */
  private applyProposeMove(op: ProposeMoveOp): QueuedResult {
    // SOURCE gate (delete oracle).
    const { zonePath: canonicalFrom, buf } = this.readSourceOrNotFound(op.from);
    const expected = assertHashFormat(op.expected_hash);
    if (hashBytes(buf) !== expected) {
      throw new BrokerError(
        "STALE_HASH",
        `expected_hash does not match the current ${op.from} — recompute and retry`,
      );
    }
    // WU-2 governed-move restriction: a belief can't be relocated by a raw move
    // (its journal path would drift from its note). `("", sourceContent)` detects
    // the absent→present governed transition, symmetric with delete's `(content, "")`.
    if (governedProvenanceChanged("", buf.toString("utf8"))) {
      throw new BrokerError(
        "LEDGER_GUARD",
        `${op.from} carries governed provenance (a ledger: block / entity) — ` +
          `relocate it with memory_retire or memory_forget, not a raw vault_propose_move`,
        true,
      );
    }
    // DESTINATION gate — ZONE BEFORE OCCUPANCY (S1).
    const { abs: toAbs, zonePath: canonicalTo } = assertContained(this.vaultRoot, op.to);
    if (resolveZone(canonicalTo, this.manifest) === "excluded") {
      throw new BrokerError("FORBIDDEN_ZONE", `cannot move into an excluded path: ${op.to}`);
    }
    if (existsSync(toAbs)) {
      throw new BrokerError(
        "DESTINATION_EXISTS",
        `move destination already exists: ${op.to} — pick a different destination or delete the occupant first`,
      );
    }
    const normalizedOp: ProposeMoveOp = {
      ...op,
      from: canonicalFrom,
      to: canonicalTo,
      expected_hash: expected,
    };
    const approvalId = this.genId("apr");
    const row: ApprovalRow = {
      id: approvalId,
      held_operation: JSON.stringify(normalizedOp),
      zone: resolveZone(canonicalTo, this.manifest),
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

  /**
   * v0.4.7: apply an approved MOVE, under the caller-held vault lock. Re-verifies
   * source (excluded≡missing, hash) AND destination (zone-before-occupancy).
   * B1: baseline-commit an untracked source BEFORE the destructive write+unlink.
   * Reuses doArchive's git MECHANICS (mkdir + writeContainedFile + unlink +
   * commitPaths + journal) but NEVER calls doArchive (its agent/scratch-only
   * zone gate would reject a trusted move — B2).
   */
  private async applyMove(op: ProposeMoveOp, approvalId: string | null): Promise<AppliedResult> {
    const { abs: fromAbs, buf } = this.readSourceOrNotFound(op.from);
    const expected = assertHashFormat(op.expected_hash);
    const sourceHash = hashBytes(buf);
    if (sourceHash !== expected) {
      throw new BrokerError(
        "STALE_HASH",
        `expected_hash does not match the current ${op.from} — recompute and retry`,
      );
    }
    const { abs: toAbs, zonePath: canonicalTo } = assertContained(this.vaultRoot, op.to);
    if (resolveZone(canonicalTo, this.manifest) === "excluded") {
      throw new BrokerError("FORBIDDEN_ZONE", `cannot move into an excluded path: ${op.to}`);
    }
    if (existsSync(toAbs)) {
      throw new BrokerError(
        "DESTINATION_EXISTS",
        `move destination already exists: ${op.to} — pick a different destination or delete the occupant first`,
      );
    }
    // B1: baseline an untracked source before the destructive write+unlink.
    if ((await this.git.fileAtHead(op.from)) === null) {
      await this.git.commitFile(
        op.from,
        `VaultLedger baseline: took pre-existing ${basename(op.from)} under ledger custody`,
      );
    }
    mkdirSync(dirname(toAbs), { recursive: true });
    // Write via the governed primitive (temp+rename, re-verified containment) —
    // never a bare writeFileSync. Passes the raw source Buffer so a non-UTF-8
    // attachment moves byte-for-byte.
    writeContainedFile(this.vaultRoot, this.manifest, op.to, buf);
    unlinkSync(fromAbs);

    const message = formatMessage({ op: "move", basename: basename(op.to), session: op.session });
    const commitSha = await this.git.commitPaths([op.from, op.to], message);

    const txnId = this.genId("txn");
    const txn: TransactionRow = {
      id: txnId,
      op: "move",
      // The transactions table has no dedicated `to` column (journal/db are out
      // of this cycle's scope); the destination is recoverable from the commit
      // and the held-op JSON. hash_before === hash_after: a move preserves bytes.
      path: op.from,
      hash_before: sourceHash,
      hash_after: sourceHash,
      session: op.session,
      reason: op.reason,
      memory_id: null,
      commit_sha: commitSha,
      approval_id: approvalId, // S3
      created_at: this.now(),
      status: "applied",
    };
    this.journal.recordTransaction(txn);

    return { ok: true, txnId, commitSha, path: op.to };
  }
}
