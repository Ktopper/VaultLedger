import { closeSync, existsSync, openSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { BrokerError } from "../errors.js";
import type { PermissionsManifest } from "../schemas/manifest.js";
import { resolveZone } from "../zones.js";

/**
 * Cache of resolved-vaultRoot -> its realpath. `realpathSync(root)` hits the
 * filesystem on every call, and this helper runs on every broker write AND
 * every server `/provenance` read — memoizing it (the realpath of a given
 * root is stable for the process's lifetime) avoids a redundant stat per
 * request. Keyed by the lexically-resolved root (the input to realpathSync)
 * so two callers passing the same vaultRoot share one entry. Module-level
 * rather than per-Broker so the server's route (which doesn't hold a Broker)
 * benefits too.
 */
const canonicalRootCache = new Map<string, string>();

function getCanonicalRoot(resolvedRoot: string): string {
  const cached = canonicalRootCache.get(resolvedRoot);
  if (cached !== undefined) return cached;
  const canonical = realpathSync(resolvedRoot);
  canonicalRootCache.set(resolvedRoot, canonical);
  return canonical;
}

/**
 * Resolve a vault-relative path to an absolute path AND enforce that it
 * stays inside the vault root AND is not in the (always-forbidden) excluded
 * zone. This is the SINGLE shared trust-boundary gate — the Broker uses it
 * for every mutating operation (create/revise/propose_edit/archive), and
 * any other in-process reader that needs to honor the exact same boundary
 * before touching vault content (e.g. the server's `GET /provenance` route,
 * which must never leak an excluded-zone note's frontmatter) calls it too,
 * rather than re-implementing containment/zone logic a second time.
 *
 * A traversal path (e.g. "Notes/../../../../etc/passwd") would otherwise
 * escape the vault — the trust boundary — and let a caller read/write
 * arbitrary files. Two layers of containment, both required:
 *
 *  1. Lexical (cheap fast-path): resolve(root, relPath) must stay under root
 *     textually. Catches ".." traversal.
 *  2. Realpath-based: a symlink INSIDE the vault (e.g. Agent/evil ->
 *     /tmp/outside) passes the lexical check but physically resolves
 *     outside the vault. Canonicalize the vault root and the nearest
 *     EXISTING ancestor of the target (walking up with dirname, since the
 *     target itself may not exist yet for a create — realpathSync throws on
 *     a nonexistent path), then assert the canonicalized ancestor is still
 *     inside the canonicalized root.
 *
 * On top of containment, the zone gate rejects the hard-always-excluded
 * paths (`.ledger/**`, `.git/**`) and anything the manifest's own `excluded`
 * globs match (see `resolveZone`) — every caller of this helper treats
 * "excluded" as an unconditional reject, so it's enforced here once rather
 * than at each call site.
 *
 * Throws BrokerError FORBIDDEN_ZONE for a traversal escape, a symlink
 * escape, or an excluded-zone path. Returns the safe absolute path
 * otherwise — callers that need STRICTER zone rules (e.g. create requires
 * agent/scratch, not just "not excluded") apply those on top of this.
 */
/** Containment + symlink-escape core (VL-SEC-S1-02), WITHOUT the zone check.
 * Throws FORBIDDEN_ZONE on a traversal or symlink escape; returns the safe
 * absolute path. Split out so a caller that must treat an excluded path
 * differently from a traversal (e.g. vault_read, which maps excluded → NOT_FOUND
 * to avoid a zone-disclosure oracle, VL-SEC-S7-04) can run containment without
 * the wrapper's excluded→FORBIDDEN_ZONE throw. `assertContainedAndReadable`
 * layers the excluded check on top — the single containment implementation. */
export function assertContained(
  vaultRoot: string,
  relPath: string,
): { abs: string; zonePath: string } {
  const root = resolve(vaultRoot);
  const abs = resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new BrokerError("FORBIDDEN_ZONE", `path escapes vault root: ${relPath}`);
  }

  const canonicalRoot = getCanonicalRoot(root);

  let ancestor: string | undefined = abs;
  while (ancestor !== undefined && !existsSync(ancestor)) {
    const parent = dirname(ancestor);
    ancestor = parent === ancestor ? undefined : parent;
  }
  const realAncestor = ancestor !== undefined ? realpathSync(ancestor) : canonicalRoot;

  if (realAncestor !== canonicalRoot && !realAncestor.startsWith(canonicalRoot + sep)) {
    throw new BrokerError("FORBIDDEN_ZONE", `path escapes vault root via symlink: ${relPath}`);
  }

  // `zonePath` is the path a ZONE check must use — the realpath of the deepest
  // existing ancestor + the lexical (non-existent) tail below it. `resolve()`/
  // `relative()` are purely LEXICAL (they never dereference symlinks), so zoning
  // the lexical `abs` would zone a symlink `Link -> Private` by the link's own
  // name ("Link", trusted) while the read/write follows it into the excluded
  // target — a real content-leak / write-gate bypass. Building `zonePath` from
  // `realAncestor` resolves BOTH `..` AND intermediate symlinks, so the zone
  // decision matches the file that is actually accessed (VL-SEC). `abs` is still
  // returned for I/O (it follows the same symlink to the same bytes).
  const tail = ancestor === undefined ? relative(canonicalRoot, abs) : relative(ancestor, abs);
  const canonicalAbs = tail === "" ? realAncestor : resolve(realAncestor, tail);
  const zonePath = relative(canonicalRoot, canonicalAbs);

  return { abs, zonePath };
}

export function assertContainedAndReadable(
  vaultRoot: string,
  manifest: PermissionsManifest,
  relPath: string,
): string {
  // Zone the CANONICAL path (realpath-resolved — collapses `..` AND dereferences
  // symlinks; see assertContained), not the raw `relPath`: a raw/lexical zone
  // check is bypassable both by `Notes/../Private/x` and by a symlink named
  // `Link -> Private`. This is the single excluded-zone enforcement point for the
  // propose/write path.
  const { abs, zonePath } = assertContained(vaultRoot, relPath);
  if (resolveZone(zonePath, manifest) === "excluded") {
    throw new BrokerError("FORBIDDEN_ZONE", `path is in excluded zone: ${relPath}`);
  }

  return abs;
}

/**
 * Governed-write primitive (VL-SEC-S1-02). EVERY leaf write the broker
 * performs on vault content must go through this — never a bare
 * `writeFileSync(abs, data)` reusing an `abs` computed by an earlier call to
 * `assertContainedAndReadable`. Two layers, both required:
 *
 *  1. Re-run the FULL synchronous ancestor-realpath walk
 *     (`assertContainedAndReadable`) immediately before writing, with ZERO
 *     `await` between this call and the temp-file write below. An earlier
 *     containment check (e.g. `resolveAbs()` at the top of `applyRevise`)
 *     can be arbitrarily stale by the time the write actually happens — real
 *     async work sits in between (patch apply, `await this.git.fileAtHead()`,
 *     a possible baseline commit) — and a concurrent process can swap the
 *     leaf for a symlink pointing outside the vault in that window. Because
 *     this function performs the re-check and the write with nothing that
 *     yields in between, no OTHER task in this process can run between them
 *     — the only remaining gap is the OS-level distance between two
 *     back-to-back syscalls (see RESIDUAL below), not the tens-of-
 *     milliseconds-wide window the earlier check left open.
 *
 *  2. Never write through the leaf path directly. `writeFileSync`'s default
 *     `'w'` flag follows a symlink at its destination — if the leaf is (or
 *     becomes, in the syscall-level gap step 1 can't close) a symlink to an
 *     outside file, a direct write lands there. Instead: create a fresh temp
 *     file in the SAME (just realpath-verified) parent directory with an
 *     UNGUESSABLE random name AND an EXCLUSIVE, non-following open
 *     (`openSync(tmp, "wx")` = `O_CREAT|O_EXCL|O_WRONLY`), then `renameSync`
 *     it onto the leaf path. Two distinct symlink vectors are closed here:
 *       - The TEMP path itself: a predictable temp name with a following
 *         write would let an attacker PRE-PLANT a symlink there (no race —
 *         planted before the op) so the payload write escapes and the rename
 *         then moves the planted symlink onto the note. The random suffix
 *         makes the name unpredictable, and O_EXCL fails `EEXIST` if the
 *         path already exists INCLUDING as a symlink — so a planted/guessed
 *         temp fails CLOSED instead of being followed.
 *       - The LEAF (destination): POSIX `rename(2)` replaces the DIRECTORY
 *         ENTRY at the destination — it does not dereference a symlink
 *         sitting there — so even if the leaf is swapped for an
 *         outside-pointing symlink in the gap between the check above and
 *         this rename, the rename destroys that symlink and installs our
 *         verified content instead of writing through it. The outside target
 *         is never touched either way.
 *     On any failure (write or rename) the temp file is unlinked so a failed
 *     governed write leaves no litter in the vault.
 *
 * RESIDUAL: Node has no `openat`/`renameat` (no way to open or rename
 * relative to an already-verified directory file descriptor), so a
 * microsecond-scale window remains between this function's realpath walk
 * and the `renameSync` call, during which a concurrent process could swap
 * an ANCESTOR DIRECTORY (not the leaf) for a symlink and redirect where the
 * temp file itself lands. That window is real but is orders of magnitude
 * smaller than the one this function closes (tens of milliseconds of async
 * work, collapsed to back-to-back syscalls with no intervening I/O or
 * scheduling point) — it is reduced, not eliminated. The TEMP-file plant
 * vector, by contrast, is fully closed (random name + O_EXCL), not merely
 * reduced.
 *
 * Returns the verified absolute path (same contract as
 * `assertContainedAndReadable`).
 */
export function writeContainedFile(
  vaultRoot: string,
  manifest: PermissionsManifest,
  relPath: string,
  data: string | NodeJS.ArrayBufferView,
  /**
   * TEST-ONLY seam: override the temp file's basename (joined to the verified
   * parent dir). Production callers NEVER pass this — the default random +
   * O_EXCL name is what closes the temp-plant vector. It exists only so a
   * regression test can pre-plant a symlink at a KNOWN temp path and assert
   * the exclusive open fails closed (EEXIST) instead of following it. It
   * cannot redirect where the governed write lands: the final `renameSync`
   * target is always the realpath-verified `abs`, never the temp path.
   */
  tmpBasenameForTest?: string,
): string {
  const abs = assertContainedAndReadable(vaultRoot, manifest, relPath);
  const dir = dirname(abs);
  // Temp file in the SAME parent directory the realpath walk above just
  // verified (keeps the rename on one filesystem — required for rename(2) to
  // be atomic — and never touches an unverified path). The name carries an
  // unguessable `randomBytes` suffix and is created with an exclusive,
  // non-following open (see the doc comment's vector analysis): O_EXCL makes
  // a pre-planted/guessed symlink at the temp path fail closed rather than be
  // followed. NEVER writeFileSync(tmp, ...) here — its default 'w' follows a
  // symlink at the destination.
  const tmpBasename =
    tmpBasenameForTest ?? `.${basename(abs)}.${process.pid}.${randomBytes(8).toString("hex")}.vl-tmp`;
  const tmp = join(dir, tmpBasename);
  const fd = openSync(tmp, "wx");
  let renamed = false;
  try {
    // Branch on the union so each writeSync overload (string vs ArrayBufferView)
    // is selected concretely; string writes default to utf8.
    if (typeof data === "string") {
      writeSync(fd, data);
    } else {
      writeSync(fd, data);
    }
    closeSync(fd);
    renameSync(tmp, abs);
    renamed = true;
  } finally {
    if (!renamed) {
      // A failure occurred (write threw before close, or rename threw). Ensure
      // the fd is closed and the temp file removed so a failed governed write
      // leaves no litter. Both cleanups are best-effort.
      try {
        closeSync(fd);
      } catch {
        /* already closed (write path succeeded but rename threw) */
      }
      try {
        unlinkSync(tmp);
      } catch {
        /* temp already gone / never fully created */
      }
    }
  }
  return abs;
}
