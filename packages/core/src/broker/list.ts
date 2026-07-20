import { readdirSync, statSync } from "node:fs";
import { BrokerError } from "../errors.js";
import type { PermissionsManifest } from "../schemas/manifest.js";
import { resolveZone } from "../zones.js";
import { assertContained } from "./containment.js";

/** Hard cap on the number of entries a single directory listing returns (§WU-3).
 * The cap is applied to the POST-OMISSION list (excluded entries already dropped),
 * NEVER the raw readdir — see the filter-before-cap invariant in `listVaultDir`.
 * A single vault folder over 1000 *visible* entries is pathological; `truncated`
 * then tells the agent to narrow. */
export const LIST_MAX_ENTRIES = 1000;

export type ListEntryKind = "file" | "dir";

export interface ListEntry {
  name: string;
  kind: ListEntryKind;
  /** Present for files only (the byte size); omitted for directories. */
  size?: number;
}

export interface VaultListResult {
  path: string;
  entries: ListEntry[];
  truncated: boolean;
}

/**
 * Governed, NON-RECURSIVE directory listing. Read-only: no Broker.apply, no lock,
 * no journal (a listing is not a mutation). Wired standalone like `readVaultFile`.
 *
 * Governance mirrors `vault_read`:
 *  - Containment/symlink escape → FORBIDDEN_ZONE (via `assertContained`).
 *  - An EXCLUDED target directory is mapped to the SAME generic NOT_FOUND as a
 *    missing one (oracle: excluded ≡ absent — the tool can't be swept to
 *    reconstruct the excluded-glob map). A file path (not a dir) → NOT_FOUND too.
 *  - Each ENTRY whose CANONICAL path resolves to the excluded zone (`.obsidian`,
 *    `.ledger`, `.git`, a manifest `Private/**`) is SILENTLY OMITTED — no flag,
 *    no marker, no count hint. Omission must be indistinguishable from "not
 *    there".
 *
 * FILTER-BEFORE-CAP (critical oracle): the excluded-entry filter runs BEFORE the
 * `maxEntries` cap. Capping the raw readdir instead would let an excluded entry
 * at the boundary flip `truncated`/the count (1000 visible + 1 excluded vs 1000
 * visible + 0 excluded), leaking the excluded entry. So we cap the already-
 * filtered list.
 */
export function listVaultDir(
  vaultRoot: string,
  manifest: PermissionsManifest,
  path: string,
  opts?: { maxEntries?: number },
): VaultListResult {
  const maxEntries = opts?.maxEntries ?? LIST_MAX_ENTRIES;

  // Containment/symlink escape → FORBIDDEN_ZONE. `zonePath` is the canonical
  // (realpath-resolved) path for the zone decision (collapses `..` AND
  // dereferences symlinks — see assertContained). `path: "."` resolves to the
  // vault root.
  const { abs, zonePath } = assertContained(vaultRoot, path);

  // Oracle: an excluded directory is indistinguishable from a missing one —
  // same generic NOT_FOUND, no zone vocabulary.
  if (resolveZone(zonePath, manifest) === "excluded") {
    throw new BrokerError("NOT_FOUND", `directory not found: ${path}`, true);
  }

  let st;
  try {
    st = statSync(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BrokerError("NOT_FOUND", `directory not found: ${path}`, true);
    }
    throw e; // EACCES etc. propagate
  }
  if (!st.isDirectory()) {
    // A file (or socket/fifo) is not a listable directory; treat it as missing
    // so the code is indistinguishable from a genuinely-absent directory.
    throw new BrokerError("NOT_FOUND", `directory not found: ${path}`, true);
  }

  const dirents = readdirSync(abs, { withFileTypes: true });
  const entries: ListEntry[] = [];
  for (const d of dirents) {
    // Build the entry's vault-relative path from the ORIGINAL input path so its
    // canonical zone is computed the same way the target's was.
    const childRel = path === "." || path === "" ? d.name : `${path}/${d.name}`;

    let entryAbs: string;
    let entryZonePath: string;
    try {
      const c = assertContained(vaultRoot, childRel);
      entryAbs = c.abs;
      entryZonePath = c.zonePath;
    } catch {
      // An entry that escapes containment (e.g. a symlink pointing outside the
      // vault) is omitted defensively — never surfaced, never crashes the loop.
      continue;
    }

    // SILENT omission: an entry whose canonical path is excluded is dropped with
    // no trace. This runs BEFORE the cap below (filter-before-cap).
    if (resolveZone(entryZonePath, manifest) === "excluded") continue;

    let est;
    try {
      est = statSync(entryAbs); // follows symlinks — kind/size reflect the target
    } catch {
      continue; // broken symlink / disappeared entry → omit
    }
    if (est.isDirectory()) {
      entries.push({ name: d.name, kind: "dir" });
    } else if (est.isFile()) {
      entries.push({ name: d.name, kind: "file", size: est.size });
    }
    // anything else (socket/fifo/…) is not a listable note or dir → omit
  }

  // Deterministic order (code-unit compare) so the payload is stable — required
  // for the payload-identity / filter-before-cap oracles.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // Cap the POST-OMISSION list (never the raw readdir).
  const truncated = entries.length > maxEntries;
  const capped = truncated ? entries.slice(0, maxEntries) : entries;
  return { path, entries: capped, truncated };
}
