import { describe, expect, test } from "vitest";
import { MemoryProvenance, MemoryStatus } from "../../src/schemas/provenance.js";

describe("MemoryStatus", () => {
  test("parses 'retired' as a valid status", () => {
    expect(MemoryStatus.parse("retired")).toBe("retired");
  });
});

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

  test("parses a block WITH all four v0.3b optional fields (derivation, retired_reason, superseded_by, score)", () => {
    const input = {
      id: "mem-004",
      status: "retired",
      created: "2026-07-02T12:00:00.000Z",
      source: "agent",
      reason: "distilled and retired",
      confidence: "high",
      supersedes: null,
      expires: null,
      derivation: { kind: "distilled", sources: ["mem-001", "mem-002"] },
      retired_reason: "superseded by distillation",
      superseded_by: "mem-005",
      score: 0.87,
    };
    const parsed = MemoryProvenance.parse(input);
    expect(parsed.derivation).toEqual({ kind: "distilled", sources: ["mem-001", "mem-002"] });
    expect(parsed.retired_reason).toBe("superseded by distillation");
    expect(parsed.superseded_by).toBe("mem-005");
    expect(parsed.score).toBe(0.87);
  });

  test("parses a block WITHOUT any of the four v0.3b fields (all optional; a note without them must still parse)", () => {
    const input = {
      id: "mem-005",
      status: "canonical",
      created: "2026-07-02T12:00:00.000Z",
      source: "user",
      reason: "no v0.3b fields at all",
      confidence: "medium",
      supersedes: null,
      expires: null,
    };
    const parsed = MemoryProvenance.parse(input);
    expect(parsed.derivation).toBeUndefined();
    expect(parsed.retired_reason).toBeUndefined();
    expect(parsed.superseded_by).toBeUndefined();
    expect(parsed.score).toBeUndefined();
  });

  test("superseded_by accepts null", () => {
    const input = {
      id: "mem-006",
      status: "retired",
      created: "2026-07-02T12:00:00.000Z",
      source: "agent",
      superseded_by: null,
    };
    const parsed = MemoryProvenance.parse(input);
    expect(parsed.superseded_by).toBeNull();
  });
});
