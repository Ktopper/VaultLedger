import { describe, expect, test } from "vitest";
import { canonicalize, extract } from "../../src/contradiction/extract.js";

describe("canonicalize", () => {
  test("ISO date passes through", () => {
    expect(canonicalize("2026-08-15")).toEqual({ type: "date", value: "2026-08-15" });
  });

  test("'Aug 15, 2026' normalizes to the same ISO date", () => {
    expect(canonicalize("Aug 15, 2026")).toEqual({ type: "date", value: "2026-08-15" });
  });

  test("'August 15, 2026' normalizes to the same ISO date", () => {
    expect(canonicalize("August 15, 2026")).toEqual({ type: "date", value: "2026-08-15" });
  });

  test("'15 Aug 2026' normalizes to the same ISO date", () => {
    expect(canonicalize("15 Aug 2026")).toEqual({ type: "date", value: "2026-08-15" });
  });

  test("date-shaped value with no determinable year is unparseable", () => {
    expect(canonicalize("Aug 15")).toEqual({ type: "unparseable", raw: "Aug 15" });
  });

  test("comma-grouped number", () => {
    expect(canonicalize("1,000")).toEqual({ type: "number", value: 1000 });
  });

  test("decimal number", () => {
    expect(canonicalize("3.5")).toEqual({ type: "number", value: 3.5 });
  });

  test("plain string is folded to lowercase, trimmed", () => {
    expect(canonicalize("Shipping")).toEqual({ type: "string", value: "shipping" });
  });

  test("internal whitespace is folded to single spaces", () => {
    expect(canonicalize("  Big   Deal  ")).toEqual({ type: "string", value: "big deal" });
  });
});

describe("extract", () => {
  test("pulls scalar frontmatter keys (except ledger) and colon-delimited body lines", () => {
    const note = `---
ledger:
  id: mem_1
deadline: 2026-08-15
status: Shipping
---
**owner:** Alice
random prose line
`;
    const facts = extract(note);

    expect(facts.get("deadline")).toEqual({ type: "date", value: "2026-08-15" });
    expect(facts.get("status")).toEqual({ type: "string", value: "shipping" });
    expect(facts.get("owner")).toEqual({ type: "string", value: "alice" });
    expect(facts.has("ledger")).toBe(false);
    expect(facts.has("id")).toBe(false);
    // "random prose line" has no colon -> not a fact.
    expect(facts.size).toBe(3);
  });

  test("first occurrence wins on duplicate folded keys (frontmatter before body)", () => {
    const note = `---
ledger:
  id: mem_1
Status: frontmatter-value
---
status: body-value
`;
    const facts = extract(note);
    expect(facts.get("status")).toEqual({ type: "string", value: "frontmatter-value" });
  });

  test("skips array/object frontmatter values", () => {
    const note = `---
ledger:
  id: mem_1
tags:
  - a
  - b
owner: Alice
---
body text without colon
`;
    const facts = extract(note);
    expect(facts.has("tags")).toBe(false);
    expect(facts.get("owner")).toEqual({ type: "string", value: "alice" });
  });
});
