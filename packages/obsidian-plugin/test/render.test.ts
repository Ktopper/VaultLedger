// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import {
  groupBySession,
  renderApprovalBody,
  renderConflict,
  renderDiff,
  renderProvenance,
} from "../src/render.js";

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

describe("renderConflict", () => {
  test("renders entity/kind/detail and both memory refs as text", () => {
    const el = renderConflict({
      row: {
        id: "cf_1",
        entity: "nova",
        kind: "value-conflict",
        detail: 'deadline: "2026-08-15" vs "2026-09-01"',
      },
      memoryA: { id: "mem_a", path: "Agent/Memory/mem_a.md" },
      memoryB: { id: "mem_b", path: "Agent/Memory/mem_b.md" },
    });
    expect(el.textContent).toContain("nova");
    expect(el.textContent).toContain("value-conflict");
    expect(el.textContent).toContain('deadline: "2026-08-15" vs "2026-09-01"');
    expect(el.textContent).toContain("mem_a");
    expect(el.textContent).toContain("Agent/Memory/mem_a.md");
    expect(el.textContent).toContain("mem_b");
    expect(el.textContent).toContain("Agent/Memory/mem_b.md");
  });

  test("a missing memory side renders as '?' rather than throwing", () => {
    const el = renderConflict({
      row: { id: "cf_1", entity: "nova", kind: "value-conflict", detail: "detail text" },
      memoryA: { id: "mem_a", path: "Agent/Memory/mem_a.md" },
      memoryB: null,
    });
    expect(el.textContent).toContain("?");
  });

  // SECURITY: every field (entity/kind/detail/id/path) comes from an agent's
  // proposed note content — attacker-influenced. renderConflict must NEVER use
  // innerHTML — only createElement + textContent — so a hostile conflict in
  // ANY field never executes.
  test("SECURITY: hostile content in EVERY field (entity/kind/detail/path) never executes — rendered as literal text", () => {
    const el = renderConflict({
      row: {
        id: "cf_1",
        entity: "<img src=e onerror=alert('entity')>",
        kind: "<script>kind()</script>",
        detail: "<img src=x onerror=alert(1)>",
      },
      memoryA: { id: "<script>ida()</script>", path: "<script>evil()</script>" },
      memoryB: { id: "mem_b", path: "<img src=b onerror=alert('pathB')>" },
    });
    // Exhaustive: no field's payload materializes as a live element.
    expect(el.querySelectorAll("img,script").length).toBe(0);
    expect(el.textContent).toContain("<img src=e onerror=alert('entity')>");
    expect(el.textContent).toContain("<script>kind()</script>");
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(el.textContent).toContain("<script>evil()</script>");
    expect(el.textContent).toContain("<img src=b onerror=alert('pathB')>");
  });
});

describe("renderApprovalBody", () => {
  test("a propose_delete renders a delete banner + the removal (`-`) content lines", () => {
    const held = JSON.stringify({ op: "propose_delete", path: "Notes/gone.md" });
    const diff = "DELETE Notes/gone.md\n-# Heading\n-body line";
    const el = renderApprovalBody(held, diff);

    expect(el.classList.contains("vl-approval-delete")).toBe(true);
    const banner = el.querySelector(".vl-delete-banner");
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("DELETED");
    // The removal lines are rendered as del-classed diff lines.
    const dels = el.querySelectorAll(".vl-diff-del");
    expect(dels.length).toBe(2);
    expect(el.textContent).toContain("-# Heading");
    expect(el.textContent).toContain("-body line");
  });

  test("a propose_move renders a `MOVE from -> to` banner and no diff body", () => {
    const held = JSON.stringify({ op: "propose_move", from: "Inbox/x.md", to: "Clients/Brandit/x.md" });
    const el = renderApprovalBody(held, "");

    expect(el.classList.contains("vl-approval-move")).toBe(true);
    const banner = el.querySelector(".vl-move-banner");
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toBe("MOVE Inbox/x.md -> Clients/Brandit/x.md");
    // A move is byte-preserving: no diff body rendered.
    expect(el.querySelector(".vl-diff")).toBeNull();
  });

  test("a non-delete/move op falls back to the plain diff render", () => {
    const held = JSON.stringify({ op: "propose_edit", path: "Notes/x.md" });
    const diff = "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new";
    const el = renderApprovalBody(held, diff);
    expect(el.classList.contains("vl-diff")).toBe(true);
    const addTexts = Array.from(el.querySelectorAll(".vl-diff-add")).map((n) => n.textContent);
    expect(addTexts).toContain("+new");
  });

  test("malformed held-operation JSON falls back to the plain diff render (never throws)", () => {
    const el = renderApprovalBody("{not json", "some context line");
    expect(el.classList.contains("vl-diff")).toBe(true);
    expect(el.textContent).toContain("some context line");
  });

  // SECURITY: the delete diff body and the move from/to are attacker-influenced
  // (an agent chose the path/content). renderApprovalBody must render them as
  // literal text — never innerHTML — so a hostile path/content never executes.
  test("SECURITY: hostile delete content and move paths render as literal text, never live nodes", () => {
    const delHeld = JSON.stringify({ op: "propose_delete", path: "Notes/x.md" });
    const delEl = renderApprovalBody(delHeld, "-<img src=x onerror=alert(1)>\n-<script>evil()</script>");
    expect(delEl.querySelectorAll("img,script").length).toBe(0);
    expect(delEl.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(delEl.textContent).toContain("<script>evil()</script>");

    const mvHeld = JSON.stringify({
      op: "propose_move",
      from: "<img src=e onerror=alert('from')>",
      to: "<script>to()</script>",
    });
    const mvEl = renderApprovalBody(mvHeld, "");
    expect(mvEl.querySelectorAll("img,script").length).toBe(0);
    expect(mvEl.textContent).toContain("<img src=e onerror=alert('from')>");
    expect(mvEl.textContent).toContain("<script>to()</script>");
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
