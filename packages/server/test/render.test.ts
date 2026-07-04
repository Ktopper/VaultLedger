import { describe, expect, test } from "vitest";
import { renderApprovalDiff, DIFF_RENDER_LIMIT } from "../src/render.js";

describe("renderApprovalDiff", () => {
  test("returns a revise/propose_edit patch as-is when under the limit", () => {
    const patch = "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n";
    const op = JSON.stringify({ op: "propose_edit", path: "Notes/x.md", patch });
    expect(renderApprovalDiff(op)).toBe(patch);
  });

  // #5: an unbounded held patch must be truncated so /approvals (which renders
  // every pending row on every call) can't be blown up by one oversized diff.
  test("truncates an oversized rendered diff with a marker", () => {
    const hugePatch = "x".repeat(DIFF_RENDER_LIMIT + 5000);
    const op = JSON.stringify({ op: "propose_edit", path: "Notes/x.md", patch: hugePatch });
    const rendered = renderApprovalDiff(op);
    expect(rendered.length).toBeLessThan(hugePatch.length);
    expect(rendered.length).toBeLessThanOrEqual(DIFF_RENDER_LIMIT + "\n…(truncated)".length);
    expect(rendered.endsWith("…(truncated)")).toBe(true);
    expect(rendered.startsWith("x")).toBe(true);
  });

  test("also truncates an oversized synthesized create diff", () => {
    const hugeContent = "line\n".repeat(DIFF_RENDER_LIMIT);
    const op = JSON.stringify({ op: "create", path: "Agent/Memory/x.md", content: hugeContent });
    const rendered = renderApprovalDiff(op);
    expect(rendered.length).toBeLessThanOrEqual(DIFF_RENDER_LIMIT + "\n…(truncated)".length);
    expect(rendered.endsWith("…(truncated)")).toBe(true);
  });
});
