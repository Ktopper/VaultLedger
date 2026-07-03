// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { groupBySession, renderDiff, renderProvenance } from "../src/render.js";

describe("renderDiff", () => {
  test("colors +/- lines and preserves line content as text", () => {
    const el = renderDiff("+ added line\n- removed line\n unchanged line");
    expect(el.tagName).toBe("DIV");
    expect(el.classList.contains("vl-diff")).toBe(true);

    const children = Array.from(el.children);
    expect(children).toHaveLength(3);

    expect(children[0]!.classList.contains("vl-diff-add")).toBe(true);
    expect(children[0]!.textContent).toBe("+ added line");

    expect(children[1]!.classList.contains("vl-diff-del")).toBe(true);
    expect(children[1]!.textContent).toBe("- removed line");

    expect(children[2]!.classList.contains("vl-diff-ctx")).toBe(true);
    expect(children[2]!.textContent).toBe(" unchanged line");
  });

  // SECURITY: a diff line is attacker-influenced content (an agent's proposed
  // patch text) rendered directly into the DOM. renderDiff must NEVER use
  // innerHTML/insertAdjacentHTML — only createElement + textContent — or a
  // hostile diff body becomes script execution in Obsidian's renderer.
  test("SECURITY: a hostile diff with HTML/script content never executes — it's rendered as literal text", () => {
    const hostile = "+ <img src=x onerror=alert(1)>\n- <script>evil()</script>\n normal";
    const el = renderDiff(hostile);

    expect(el.querySelectorAll("img,script").length).toBe(0);
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(el.textContent).toContain("<script>evil()</script>");
  });

  test("empty diff text renders a single empty context line ('' splits to one empty line)", () => {
    const el = renderDiff("");
    expect(el.children).toHaveLength(1);
    expect(el.children[0]!.textContent).toBe("");
    expect(el.children[0]!.classList.contains("vl-diff-ctx")).toBe(true);
  });
});

describe("renderProvenance", () => {
  test("renders labeled fields via textContent", () => {
    const el = renderProvenance({
      source: "agent-x",
      reason: "seed fact",
      status: "working",
      confidence: "medium",
      created: "2026-01-01T00:00:00.000Z",
      expires: "2026-02-01T00:00:00.000Z",
    });
    expect(el.textContent).toContain("agent-x");
    expect(el.textContent).toContain("seed fact");
    expect(el.textContent).toContain("working");
    expect(el.textContent).toContain("medium");
  });

  // SECURITY: provenance fields (source/reason/...) come from note frontmatter
  // an agent wrote — also attacker-influenced. Same textContent-only contract.
  test("SECURITY: a hostile provenance reason never executes — rendered as literal text", () => {
    const el = renderProvenance({ reason: "<img onerror=alert(1)>" });
    expect(el.querySelectorAll("img").length).toBe(0);
    expect(el.textContent).toContain("<img onerror=alert(1)>");
  });
});

describe("groupBySession", () => {
  test("groups transactions by session, preserving first-seen order", () => {
    const txns = [
      { session: "s1", id: "a" },
      { session: "s2", id: "b" },
      { session: "s1", id: "c" },
      { session: "s3", id: "d" },
      { session: "s2", id: "e" },
    ];
    const grouped = groupBySession(txns);
    expect(grouped.map((g) => g.session)).toEqual(["s1", "s2", "s3"]);
    expect(grouped[0]!.txns.map((t) => t.id)).toEqual(["a", "c"]);
    expect(grouped[1]!.txns.map((t) => t.id)).toEqual(["b", "e"]);
    expect(grouped[2]!.txns.map((t) => t.id)).toEqual(["d"]);
  });

  test("empty input yields empty groups", () => {
    expect(groupBySession([])).toEqual([]);
  });
});
