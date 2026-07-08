import { describe, expect, test } from "vitest";
import { HeuristicDetector } from "../../src/contradiction/detector.js";

function note(frontmatter: Record<string, string>, body = ""): { text: string } {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return {
    text: `---\nledger:\n  id: mem_x\n${fm}\n---\n${body}\n`,
  };
}

describe("HeuristicDetector", () => {
  const detector = new HeuristicDetector();

  test("value-conflict: same key, different date value", () => {
    const a = note({ deadline: "2026-08-15" });
    const b = note({ deadline: "2026-09-01" });
    const conflicts = detector.detect(a, b);
    expect(conflicts).toEqual([
      {
        kind: "value-conflict",
        factKey: "deadline",
        detail: 'deadline: "2026-08-15" vs "2026-09-01"',
        values: ["2026-08-15", "2026-09-01"],
      },
    ]);
  });

  test("near-miss is NOT flagged: differently-formatted but equal dates", () => {
    const a = note({ deadline: "Aug 15, 2026" });
    const b = note({ deadline: "2026-08-15" });
    expect(detector.detect(a, b)).toEqual([]);
  });

  test("unparseable (yearless date-shaped) is NOT flagged", () => {
    const a = note({ due: "Aug 15" });
    const b = note({ due: "Sep 1" });
    expect(detector.detect(a, b)).toEqual([]);
  });

  test("type mismatch (number vs string) is NOT flagged", () => {
    const a = note({ size: "10" });
    const b = note({ size: "large" });
    expect(detector.detect(a, b)).toEqual([]);
  });

  test("multi-fact: two independent value-conflicts are both reported", () => {
    const a = note({ deadline: "2026-08-15", status: "shipping" });
    const b = note({ deadline: "2026-09-01", status: "blocked" });
    const conflicts = detector.detect(a, b);
    expect(conflicts).toHaveLength(2);
    expect(conflicts).toEqual(
      expect.arrayContaining([
        {
          kind: "value-conflict",
          factKey: "deadline",
          detail: 'deadline: "2026-08-15" vs "2026-09-01"',
          values: ["2026-08-15", "2026-09-01"],
        },
        {
          kind: "value-conflict",
          factKey: "status",
          detail: 'status: "shipping" vs "blocked"',
          values: ["shipping", "blocked"],
        },
      ]),
    );
  });

  test("negation-conflict: same subject + object, one negated", () => {
    const a = note({}, "The project is active");
    const b = note({}, "The project is not active");
    const conflicts = detector.detect(a, b);
    expect(conflicts).toEqual([
      {
        kind: "negation-conflict",
        factKey: "the project::active",
        detail: '"the project is active" contradicted by negation',
        values: ["the project::active", "the project::not active"],
      },
    ]);
  });

  test("negation-conflict: contracted \"isn't\" is recognized as a negation of \"is\"", () => {
    const a = note({}, "The build is green");
    const b = note({}, "The build isn't green");
    const conflicts = detector.detect(a, b);
    expect(conflicts).toEqual([
      {
        kind: "negation-conflict",
        factKey: "the build::green",
        detail: '"the build is green" contradicted by negation',
        values: ["the build::green", "the build::not green"],
      },
    ]);
  });

  test("negation with different object is NOT flagged", () => {
    const a = note({}, "The project is active");
    const b = note({}, "The project is delayed");
    expect(detector.detect(a, b)).toEqual([]);
  });

  test("identical values -> no conflict", () => {
    const a = note({ deadline: "2026-08-15" });
    const b = note({ deadline: "2026-08-15" });
    expect(detector.detect(a, b)).toEqual([]);
  });

  test("disjoint keys -> no conflict", () => {
    const a = note({ deadline: "2026-08-15" });
    const b = note({ owner: "Alice" });
    expect(detector.detect(a, b)).toEqual([]);
  });
});
