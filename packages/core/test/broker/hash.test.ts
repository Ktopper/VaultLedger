import { describe, expect, test, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBytes, hashFile } from "../../src/broker/hash.js";
import { BrokerError } from "../../src/errors.js";

describe("hashBytes", () => {
  test("returns sha256:<hex> for known bytes", () => {
    const buf = Buffer.from("hello world", "utf8");
    const expected = createHash("sha256").update(buf).digest("hex");
    expect(hashBytes(buf)).toBe(`sha256:${expected}`);
  });

  test("matches known sha256 for empty buffer", () => {
    const buf = Buffer.from("", "utf8");
    expect(hashBytes(buf)).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("hashFile", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test("matches hashBytes of the file's content", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-hash-"));
    const filePath = join(dir, "note.md");
    const content = "# Some Note\n\nBody text.\n";
    writeFileSync(filePath, content, "utf8");

    expect(hashFile(filePath)).toBe(hashBytes(Buffer.from(content, "utf8")));
  });

  test("throws NOT_FOUND BrokerError for a missing path", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-hash-"));
    const missing = join(dir, "does-not-exist.md");

    expect(() => hashFile(missing)).toThrow(BrokerError);
    try {
      hashFile(missing);
      throw new Error("expected hashFile to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrokerError);
      expect((e as BrokerError).code).toBe("NOT_FOUND");
    }
  });
});
