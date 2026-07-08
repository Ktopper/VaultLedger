import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { BrokerError } from "../errors.js";

export function hashBytes(buf: Buffer): string {
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

// Canonical `expected_hash` format: `sha256:` followed by exactly 64 hex
// digits. Case-insensitive on input (a client that uppercases hex is not
// penalized for an otherwise-correct hash) -- the caller must normalize
// with `assertHashFormat` before comparing/storing so an uppercase-but-
// correct hash still matches a lowercase-computed digest.
const HASH_FORMAT = /^sha256:[0-9a-fA-F]{64}$/;

/**
 * Validate that `expectedHash` matches the canonical `sha256:<64 hex>`
 * format and return it normalized to lowercase. Throws `BrokerError`
 * (`MALFORMED_HASH`) if the format doesn't match -- e.g. a bare hex digest
 * missing the `sha256:` prefix. This is a format check only, distinct from
 * `STALE_HASH` (which means the value is well-formed but no longer matches
 * the file on disk).
 */
export function assertHashFormat(expectedHash: string): string {
  if (!HASH_FORMAT.test(expectedHash)) {
    throw new BrokerError(
      "MALFORMED_HASH",
      `expected_hash must match sha256:<64 hex digits>, got: ${expectedHash}`,
    );
  }
  return expectedHash.toLowerCase();
}

export function hashFile(path: string): string {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (e) {
    // Only a genuinely-missing path is a NOT_FOUND rejection. Other fs errors
    // (EISDIR, EACCES, ...) indicate a different fault and must not be masked;
    // let the original errno error propagate.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BrokerError("NOT_FOUND", `file not found: ${path}`);
    }
    throw e;
  }
  return hashBytes(buf);
}
