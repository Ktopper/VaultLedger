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
  } catch {
    throw new BrokerError("NOT_FOUND", `file not found: ${path}`);
  }
  return hashBytes(buf);
}
