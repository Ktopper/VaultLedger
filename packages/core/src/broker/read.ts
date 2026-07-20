import { readFileSync, statSync } from "node:fs";
import { BrokerError } from "../errors.js";
import type { PermissionsManifest } from "../schemas/manifest.js";
import { resolveZone } from "../zones.js";
import { assertContained } from "./containment.js";
import { hashBytes } from "./hash.js";

/** Hard cap on a single governed read (§2). 4× the 16 KiB propose-input cap:
 * a note being edited is routinely larger than any one replacement, so the read
 * cap must exceed the propose cap; 64 KiB covers a long-form note while bounding
 * the response. Over cap → FILE_TOO_LARGE (checked on statSync().size, before
 * the read — a huge file is never loaded). */
export const READ_MAX_BYTES = 64 * 1024;

export interface VaultReadResult {
  path: string;
  content: string;
  hash: string;
  size: number;
}

/**
 * Governed read of a single vault file. Returns the exact bytes and their
 * canonical sha256 under the invariant `hashBytes(utf8(content)) === hash` — so
 * the result directly feeds vault_propose_replace (hash → expected_hash, content
 * → source of old_text). No Broker.apply, no lock, no journal (a read is not a
 * mutation; safety rests on the hash, which propose re-verifies → STALE_HASH).
 *
 * Governance: same containment as propose (traversal/symlink → FORBIDDEN_ZONE),
 * but an EXCLUDED path is mapped to NOT_FOUND — byte-identical to a missing file
 * — so the tool can't be swept to reconstruct the excluded-glob map (VL-SEC-S7-04).
 */
export function readVaultFile(
  vaultRoot: string,
  manifest: PermissionsManifest,
  path: string,
  opts?: { maxBytes?: number },
): VaultReadResult {
  const maxBytes = opts?.maxBytes ?? READ_MAX_BYTES;

  // Containment/symlink only (traversal/symlink escape → FORBIDDEN_ZONE).
  const abs = assertContained(vaultRoot, path);

  // Oracle rule (§3): an excluded path is indistinguishable from a missing one.
  // Map it to the SAME generic NOT_FOUND — no zone vocabulary — right here, at
  // the read boundary (propose keeps FORBIDDEN_ZONE; unchanged).
  if (resolveZone(path, manifest) === "excluded") {
    throw new BrokerError("NOT_FOUND", `file not found: ${path}`, true);
  }

  let st;
  try {
    st = statSync(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BrokerError("NOT_FOUND", `file not found: ${path}`, true);
    }
    throw e; // EACCES etc. propagate
  }
  if (!st.isFile()) {
    // A directory (or socket/fifo) is not a readable note; treat as missing so a
    // dir never reaches readFileSync (raw EISDIR the harness would mislabel).
    throw new BrokerError("NOT_FOUND", `file not found: ${path}`, true);
  }
  if (st.size > maxBytes) {
    throw new BrokerError(
      "FILE_TOO_LARGE",
      `file ${path} is ${st.size} bytes, over the ${maxBytes}-byte read cap; it ` +
        `cannot be read or structured-edited — ask a human to edit it directly, ` +
        `do not reconstruct its contents from memory`,
    );
  }

  const buf = readFileSync(abs);
  const hash = hashBytes(buf);
  const content = buf.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(buf)) {
    throw new BrokerError(
      "NOT_TEXT",
      `file ${path} is not valid UTF-8 text (binary or non-text); vault_read serves text notes only`,
    );
  }
  return { path, content, hash, size: buf.length };
}
