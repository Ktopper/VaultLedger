import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { BrokerError } from "../errors.js";

export function hashBytes(buf: Buffer): string {
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
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
