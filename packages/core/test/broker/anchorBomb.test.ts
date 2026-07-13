import { describe, expect, test } from "vitest";
import { governedProvenanceChanged } from "../../src/broker/lint.js";

/**
 * VL-SEC-S4-03: js-yaml (via gray-matter) resolves YAML anchors/aliases
 * (`*name`) as shared object REFERENCES -- parsing an anchor bomb is cheap
 * (~0ms, see security/poc/s4-02b). But `governedProvenanceChanged` built a
 * fresh, fully-materialized canonical COPY of the reference-shared tree with
 * a naive recursive `value.map(canonicalize)` / per-key rebuild (no
 * memoization) and then `JSON.stringify`'d it -- both steps independently
 * re-walk every shared reference from scratch, fully MATERIALIZING the
 * exponential alias expansion -- a ~600-byte hostile `ledger:` block is
 * enough to OOM-crash the process. This runs SYNCHRONOUSLY on every
 * unapproved `memory_revise` call (scratch/working memories revise
 * immediately, no queue -- see store.ts `revise()`).
 *
 * `assertStructurePreserved` does not validate `ledger:` block CONTENTS
 * (only that a closed frontmatter block still exists), so a hostile `patch`
 * argument reaching an existing note's `ledger:` block via memory_revise can
 * inject an anchor bomb there.
 */
function buildAnchorBombLedger(depth: number, breadth: number, leaf: string): string {
  const lines: string[] = [];
  let prevVar: string | null = null;
  const indent = "    "; // nested under `ledger:` mapping key `bomb:`
  for (let d = 0; d < depth; d++) {
    const varName = "v" + d;
    if (prevVar === null) {
      const items = Array.from({ length: breadth }, () => JSON.stringify(leaf)).join(",");
      lines.push(`${indent}${varName}: &${varName} [${items}]`);
    } else {
      const items = Array.from({ length: breadth }, () => `*${prevVar}`).join(",");
      lines.push(`${indent}${varName}: &${varName} [${items}]`);
    }
    prevVar = varName;
  }
  return lines.join("\n");
}

function buildBombNote(bombDepth: number, bombBreadth: number, leaf = "x"): string {
  return `---
ledger:
  status: scratch
  session: attacker-session
  reason: seed
  bomb:
${buildAnchorBombLedger(bombDepth, bombBreadth, leaf)}
entity: null
---
Some scratch memory body text.
`;
}

/** A genuinely CYCLIC anchor -- `bomb.self === bomb` -- js-yaml materializes
 * this into an actually-circular JS object (not just a deeply-shared DAG). A
 * compute-once completed-cache ALONE still stack-overflows on this: the
 * cache entry for `bomb` isn't written until its own recursive call returns,
 * so re-entering `bomb` from inside its own subtree recurses forever before
 * ever hitting the cache. Only an in-progress marker (checked BEFORE
 * recursing into children) breaks the cycle. */
function buildCyclicNote(status: string): string {
  return `---
ledger:
  status: ${status}
  bomb: &a
    self: *a
entity: null
---
Some scratch memory body text.
`;
}

describe("governedProvenanceChanged (VL-SEC-S4-03 YAML anchor-bomb DoS)", () => {
  test("a hostile anchor bomb injected into an unrelated note's ledger block is detected fast (the realistic attack shape)", () => {
    // Mirrors security/poc/s4-03-ledger-anchor-bomb-oom.mjs exactly: `before`
    // is an ordinary note's trivial ledger block, `after` is the attacker's
    // injected bomb. depth=8/breadth=8 measured ~659ms pre-fix (naive
    // canonicalize+stringify); depth=10 crashed outright. This must reject
    // fast regardless of depth since the top-level shape mismatch (before
    // has key "v0" only, after has "v0".."v11") is detected immediately.
    const before = buildBombNote(1, 2);
    const after = buildBombNote(12, 8); // deliberately past the PoC's depth-10 crash point

    const t0 = Date.now();
    const changed = governedProvenanceChanged(before, after);
    const elapsed = Date.now() - t0;

    expect(changed).toBe(true);
    expect(elapsed, `took ${elapsed}ms`).toBeLessThan(100);
  });

  test("two SAME-SHAPE deep fan-out anchor bombs with one real difference are compared without exponential blowup", () => {
    // Both sides have the IDENTICAL depth=12/breadth=8 shared-alias shape
    // (same key set at every level), so the top-level shape-mismatch
    // short-circuit above does NOT apply here -- this is the case that
    // actually exercises the pairwise (nodeA, nodeB) memoization: without
    // it, walking two same-shaped depth-12/breadth-8 trees pairwise would
    // itself be exponential (8^12 comparisons).
    const before = buildBombNote(12, 8, "x");
    const after = buildBombNote(12, 8, "y"); // only the deepest leaf differs

    const t0 = Date.now();
    const changed = governedProvenanceChanged(before, after);
    const elapsed = Date.now() - t0;

    expect(changed).toBe(true);
    expect(elapsed, `took ${elapsed}ms`).toBeLessThan(100);
  });

  test("two SAME-SHAPE deep fan-out anchor bombs that are truly identical compare as unchanged, fast", () => {
    // `before` and `after` are separately-parsed (two independent matter()
    // calls, two independent object graphs) but textually identical --
    // there is no reference equality between the two sides at all, so this
    // forces a genuine value-level walk of the full depth-12/breadth-8
    // shape on both sides, pair-memoized.
    const note = buildBombNote(12, 8, "x");

    const t0 = Date.now();
    const changed = governedProvenanceChanged(note, note);
    const elapsed = Date.now() - t0;

    expect(changed).toBe(false);
    expect(elapsed, `took ${elapsed}ms`).toBeLessThan(100);
  });

  test("a genuinely cyclic self-referential anchor does not stack-overflow", () => {
    const before = buildCyclicNote("scratch");
    const after = buildCyclicNote("working");

    expect(() => governedProvenanceChanged(before, after)).not.toThrow();
    expect(governedProvenanceChanged(before, after)).toBe(true);
  });

  test("an identical cyclic self-referential anchor compares as unchanged", () => {
    const note = buildCyclicNote("scratch");
    expect(() => governedProvenanceChanged(note, note)).not.toThrow();
    expect(governedProvenanceChanged(note, note)).toBe(false);
  });

  test("a legit shared-alias value used at two governed keys still detects a real change (ref-aware equality preserved)", () => {
    const before = `---
ledger:
  status: working
  shared: &s ["a","b"]
  other: *s
entity: alice
---
Body.
`;
    const after = `---
ledger:
  status: working
  shared: &s ["a","b","c"]
  other: *s
entity: alice
---
Body.
`;
    expect(governedProvenanceChanged(before, after)).toBe(true);
  });

  test("a legit shared-alias value used at two governed keys compares as unchanged when truly identical", () => {
    const note = `---
ledger:
  status: working
  shared: &s ["a","b"]
  other: *s
entity: alice
---
Body.
`;
    expect(governedProvenanceChanged(note, note)).toBe(false);
  });
});
