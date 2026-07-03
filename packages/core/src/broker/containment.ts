import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { BrokerError } from "../errors.js";
import type { PermissionsManifest } from "../schemas/manifest.js";
import { resolveZone } from "../zones.js";

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
export function assertContainedAndReadable(
  vaultRoot: string,
  manifest: PermissionsManifest,
  relPath: string,
): string {
  const root = resolve(vaultRoot);
  const abs = resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new BrokerError("FORBIDDEN_ZONE", `path escapes vault root: ${relPath}`);
  }

  const canonicalRoot = realpathSync(root);

  let ancestor: string | undefined = abs;
  while (ancestor !== undefined && !existsSync(ancestor)) {
    const parent = dirname(ancestor);
    ancestor = parent === ancestor ? undefined : parent;
  }
  const realAncestor = ancestor !== undefined ? realpathSync(ancestor) : canonicalRoot;

  if (realAncestor !== canonicalRoot && !realAncestor.startsWith(canonicalRoot + sep)) {
    throw new BrokerError("FORBIDDEN_ZONE", `path escapes vault root via symlink: ${relPath}`);
  }

  const zone = resolveZone(relPath, manifest);
  if (zone === "excluded") {
    throw new BrokerError("FORBIDDEN_ZONE", `path is in excluded zone: ${relPath}`);
  }

  return abs;
}
