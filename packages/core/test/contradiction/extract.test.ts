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

  test("currency-prefixed amounts canonicalize to the bare number", () => {
    expect(canonicalize("$1,000")).toEqual({ type: "number", value: 1000 });
    expect(canonicalize("$1000.00")).toEqual({ type: "number", value: 1000 });
    expect(canonicalize("€1,000")).toEqual({ type: "number", value: 1000 });
  });

  test("trailing punctuation is stripped from string values", () => {
    expect(canonicalize("Alice.")).toEqual({ type: "string", value: "alice" });
    expect(canonicalize("Alice")).toEqual({ type: "string", value: "alice" });
  });

  test("ambiguous slash dates are unparseable (never guessed)", () => {
    expect(canonicalize("8/15/2026")).toEqual({ type: "unparseable", raw: "8/15/2026" });
    expect(canonicalize("08/15/2026")).toEqual({ type: "unparseable", raw: "08/15/2026" });
  });

  test("year-first slash date parses to ISO (unambiguous)", () => {
    expect(canonicalize("2026/08/15")).toEqual({ type: "date", value: "2026-08-15" });
  });

  test("a datetime with a 'T' time component is unparseable (no day-shift risk)", () => {
    expect(canonicalize("2026-08-15T09:00:00")).toEqual({
      type: "unparseable",
      raw: "2026-08-15T09:00:00",
    });
  });

  test("a datetime with a space-separated time component is unparseable", () => {
    expect(canonicalize("2026-08-15 09:00")).toEqual({
      type: "unparseable",
      raw: "2026-08-15 09:00",
    });
  });

  test("a bare date (no time) still canonicalizes to a date", () => {
    expect(canonicalize("2026-08-15")).toEqual({ type: "date", value: "2026-08-15" });
  });

  test("calendar-invalid dates are unparseable", () => {
    expect(canonicalize("2026-02-31")).toEqual({ type: "unparseable", raw: "2026-02-31" });
    expect(canonicalize("2026-13-01")).toEqual({ type: "unparseable", raw: "2026-13-01" });
    expect(canonicalize("2026-00-10")).toEqual({ type: "unparseable", raw: "2026-00-10" });
    expect(canonicalize("2026-04-31")).toEqual({ type: "unparseable", raw: "2026-04-31" });
    expect(canonicalize("2026-02-29")).toEqual({ type: "unparseable", raw: "2026-02-29" });
  });

  test("leap-year Feb 29 is valid; non-leap Feb 28/Dec 31 are valid", () => {
    expect(canonicalize("2024-02-29")).toEqual({ type: "date", value: "2024-02-29" });
    expect(canonicalize("2026-02-28")).toEqual({ type: "date", value: "2026-02-28" });
    expect(canonicalize("2026-12-31")).toEqual({ type: "date", value: "2026-12-31" });
  });

  test("calendar-invalid month-name dates are unparseable", () => {
    expect(canonicalize("Apr 31, 2026")).toEqual({ type: "unparseable", raw: "Apr 31, 2026" });
    expect(canonicalize("31 Apr 2026")).toEqual({ type: "unparseable", raw: "31 Apr 2026" });
  });

  test("NFC/NFD unicode forms canonicalize equal", () => {
    const nfc = "café".normalize("NFC");
    const nfd = "café".normalize("NFD");
    expect(nfc).not.toBe(nfd); // genuinely different byte sequences
    expect(canonicalize(nfc)).toEqual(canonicalize(nfd));
    expect(canonicalize(nfd)).toEqual({ type: "string", value: "café".normalize("NFC") });
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

  test("top-level `entity` is NOT a fact (it's the comparison key / provenance metadata)", () => {
    const note = `---
ledger:
  id: mem_1
entity: nova
deadline: 2026-08-15
---
body
`;
    const facts = extract(note);
    // entity is the same-entity grouping key, excluded like `ledger` — folding
    // it in caused false-positive staleness on an entity-only revise.
    expect(facts.has("entity")).toBe(false);
    expect(facts.get("deadline")).toEqual({ type: "date", value: "2026-08-15" });
    expect(facts.size).toBe(1);
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

  test("body line with a fullwidth colon (U+FF1A) is extracted as a fact", () => {
    const note = `---
ledger:
  id: mem_1
---
owner：Alice
`;
    const facts = extract(note);
    expect(facts.get("owner")).toEqual({ type: "string", value: "alice" });
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

  test("a bare URL in a body line is not parsed as a fact (no spurious 'https' key)", () => {
    const note = `---
ledger:
  id: mem_1
---
See https://example.com for details
owner: Alice
`;
    const facts = extract(note);
    expect(facts.has("https")).toBe(false);
    expect(facts.get("owner")).toEqual({ type: "string", value: "alice" });
    expect(facts.size).toBe(1);
  });

  test("frontmatter datetime with a time component is unparseable (no UTC day-shift)", () => {
    const note = `---
ledger:
  id: mem_1
when: 2026-08-15T09:00:00Z
---
`;
    const facts = extract(note);
    const when = facts.get("when");
    expect(when?.type).toBe("unparseable");
  });

  test("frontmatter bare date still canonicalizes to a date", () => {
    const note = `---
ledger:
  id: mem_1
deadline: 2026-08-15
---
`;
    const facts = extract(note);
    expect(facts.get("deadline")).toEqual({ type: "date", value: "2026-08-15" });
  });

  test("two notes with different body URLs produce no 'https' fact on either side", () => {
    const noteA = `---
ledger:
  id: mem_1
---
See https://example.com for details
`;
    const noteB = `---
ledger:
  id: mem_2
---
See https://other.example for details
`;
    expect(extract(noteA).has("https")).toBe(false);
    expect(extract(noteB).has("https")).toBe(false);
  });
});
