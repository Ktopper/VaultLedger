import { describe, expect, test } from "vitest";
import { MemoryProvenance } from "../../src/schemas/provenance.js";

describe("MemoryProvenance", () => {
  test("parses a full provenance block", () => {
    const input = {
      id: "mem-001",
      status: "canonical",
      created: "2026-07-02T12:00:00.000Z",
      source: "user",
      reason: "initial capture",
      confidence: "high",
      supersedes: "mem-000",
      expires: "2026-08-01T00:00:00.000Z",
    };
    const parsed = MemoryProvenance.parse(input);
    expect(parsed).toEqual(input);
  });

  test("accepts null for supersedes and expires", () => {
    const input = {
      id: "mem-002",
      status: "working",
      created: "2026-07-02T12:00:00.000Z",
      source: "agent",
      reason: "",
      confidence: "medium",
      supersedes: null,
      expires: null,
    };
    const parsed = MemoryProvenance.parse(input);
    expect(parsed.supersedes).toBeNull();
    expect(parsed.expires).toBeNull();
  });

  test("throws on invalid status", () => {
    const input = {
      id: "mem-003",
      status: "bogus",
      created: "2026-07-02T12:00:00.000Z",
      source: "user",
    };
    expect(() => MemoryProvenance.parse(input)).toThrow();
  });
});
