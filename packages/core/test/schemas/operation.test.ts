import { describe, expect, test } from "vitest";
import { ProposedOperation } from "../../src/schemas/operation.js";

describe("ProposedOperation", () => {
  test("create op parses with content", () => {
    const input = {
      op: "create",
      path: "Notes/foo.md",
      content: "hello world",
      reason: "capture a note",
      session: "sess-1",
    };
    const parsed = ProposedOperation.parse(input);
    expect(parsed.op).toBe("create");
    if (parsed.op === "create") {
      expect(parsed.content).toBe("hello world");
    }
  });

  test("create op rejects when expected_hash is present", () => {
    const input = {
      op: "create",
      path: "Notes/foo.md",
      content: "hello world",
      expected_hash: "abc123",
      reason: "capture a note",
      session: "sess-1",
    };
    expect(() => ProposedOperation.parse(input)).toThrow();
  });

  test("revise op rejects when missing expected_hash and patch", () => {
    const input = {
      op: "revise",
      path: "Notes/foo.md",
      reason: "fix typo",
      session: "sess-1",
    };
    expect(() => ProposedOperation.parse(input)).toThrow();
  });

  test("revise op parses when expected_hash and patch present", () => {
    const input = {
      op: "revise",
      path: "Notes/foo.md",
      expected_hash: "abc123",
      patch: "--- a\n+++ b\n",
      reason: "fix typo",
      session: "sess-1",
    };
    const parsed = ProposedOperation.parse(input);
    expect(parsed.op).toBe("revise");
    if (parsed.op === "revise") {
      expect(parsed.expected_hash).toBe("abc123");
      expect(parsed.patch).toBe("--- a\n+++ b\n");
    }
  });

  test("propose_edit op parses when expected_hash and patch present", () => {
    const input = {
      op: "propose_edit",
      path: "Notes/foo.md",
      expected_hash: "abc123",
      patch: "--- a\n+++ b\n",
      reason: "suggest edit",
      session: "sess-1",
    };
    const parsed = ProposedOperation.parse(input);
    expect(parsed.op).toBe("propose_edit");
    if (parsed.op === "propose_edit") {
      expect(parsed.expected_hash).toBe("abc123");
      expect(parsed.patch).toBe("--- a\n+++ b\n");
    }
  });

  test("propose_edit op rejects an unknown extra key (strict survives extend)", () => {
    const input = {
      op: "propose_edit",
      path: "Notes/foo.md",
      expected_hash: "abc123",
      patch: "--- a\n+++ b\n",
      bogus: "nope",
      reason: "suggest edit",
      session: "sess-1",
    };
    expect(() => ProposedOperation.parse(input)).toThrow();
  });

  test("promote op parses with target_status", () => {
    const input = {
      op: "promote",
      id: "mem-001",
      target_status: "canonical",
      reason: "confirmed by user",
      session: "sess-1",
    };
    const parsed = ProposedOperation.parse(input);
    expect(parsed.op).toBe("promote");
    if (parsed.op === "promote") {
      expect(parsed.target_status).toBe("canonical");
    }
  });

  test("forget op parses with id", () => {
    const input = { op: "forget", id: "mem-001", reason: "obsolete", session: "sess-1" };
    const parsed = ProposedOperation.parse(input);
    expect(parsed.op).toBe("forget");
  });

  test("all ops require non-empty reason and session", () => {
    const input = {
      op: "forget",
      id: "mem-001",
      reason: "",
      session: "sess-1",
    };
    expect(() => ProposedOperation.parse(input)).toThrow();
  });
});
