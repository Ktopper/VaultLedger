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

  // v0.4.7: propose_delete has no content on the held op — the caller supplies
  // the current bytes via opts.deleteContent, rendered as a DELETE header plus
  // every content line as a `-` removal.
  test("propose_delete renders a DELETE header + the content as `-` removal lines", () => {
    const op = JSON.stringify({ op: "propose_delete", path: "Notes/gone.md" });
    const rendered = renderApprovalDiff(op, { deleteContent: "line one\nline two\n" });
    expect(rendered).toContain("DELETE Notes/gone.md");
    expect(rendered).toContain("-line one");
    expect(rendered).toContain("-line two");
  });

  // N1: a delete whose source couldn't be read (opts.deleteContent absent) must
  // NOT throw — it renders an unavailable marker so the /approvals loop keeps
  // rendering every other row.
  test("propose_delete with no deleteContent renders an `unavailable` marker (never throws)", () => {
    const op = JSON.stringify({ op: "propose_delete", path: "Notes/absent.md" });
    const rendered = renderApprovalDiff(op);
    expect(rendered).toBe("— Notes/absent.md unavailable");
  });

  test("propose_move renders `MOVE from -> to` with no diff body", () => {
    const op = JSON.stringify({ op: "propose_move", from: "Inbox/x.md", to: "Clients/Brandit/x.md" });
    const rendered = renderApprovalDiff(op);
    expect(rendered).toBe("MOVE Inbox/x.md -> Clients/Brandit/x.md");
  });
});
