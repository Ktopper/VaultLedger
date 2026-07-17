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
 *
 * Accepts `string | undefined` (not just `string`): with `expected_hash`
 * schema-optional on revise/propose_edit, an edit that omits it arrives here
 * as `undefined`. That is a DELIBERATE throw — `HASH_FORMAT.test(undefined)`
 * coerces to the string `"undefined"`, matches nothing, and rejects with
 * MALFORMED_HASH, which is exactly the desired behavior (a hash-less edit is
 * rejected). The broker only calls this on the edit branch; the creation
 * branch forbids a hash separately.
 */
export function assertHashFormat(expectedHash: string | undefined): string {
  // `undefined` is a DELIBERATE throw: a hash-less edit must be rejected with
  // MALFORMED_HASH. The template literal below coerces it to "undefined" in the
  // message, exactly as the previous `HASH_FORMAT.test(String(undefined))` did.
  if (expectedHash === undefined || !HASH_FORMAT.test(expectedHash)) {
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
