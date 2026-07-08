import matter from "gray-matter";
import { extract } from "./extract.js";
import type { CanonicalValue } from "./extract.js";

export type ConflictKind = "value-conflict" | "negation-conflict";

export interface DetectedConflict {
  kind: ConflictKind;
  factKey: string;
  detail: string;
  /**
   * The two conflicting sides, in the same (a, b) order as `detect`'s
   * arguments (check.ts always calls detect(loText, hiText), so index 0
   * lines up with pair_lo). For `value-conflict` this is the two
   * canonicalized fact values (as display strings); for `negation-conflict`
   * it's the two folded statements (subject+negation+object). Consumed by
   * `contradiction/valueHash.ts`'s `conflictValueHash` to compute an
   * order-normalized hash that gets folded into the conflicts table's unique
   * dedup key — without it, a conflict dismissed once on a given pair+fact
   * would silently swallow every later, differently-valued contradiction on
   * that same pair+fact (ON CONFLICT DO NOTHING colliding on the old
   * 4-column key).
   */
  values: [string, string];
}

export interface ContradictionDetector {
  detect(a: { text: string }, b: { text: string }): DetectedConflict[];
}

// Simple declarative statement: "<subject> is [not|no longer] <object>" or
// "<subject> isn't <object>". Exact normalized subject+object match only — no
// fuzzy matching. Intentionally narrow: one "X is Y" clause per line;
// compound sentences (multiple clauses / conjunctions) are scoped out by
// design to keep precision high.
//
// "isn't" is matched as its own alternative (not as a suffix on "is\s+")
// because "is" in "isn't" is not followed by whitespace — "X isn't Y" has no
// standalone " is " substring for the first alternative to anchor on.
const NEGATION_LINE_RE = /^\s*(.+?)\s+(?:is\s+(not\s+|no longer\s+)?|(isn't)\s+)(.+?)\s*$/i;

function fold(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function displayValue(v: CanonicalValue): string {
  switch (v.type) {
    case "date":
      return v.value;
    case "number":
      return String(v.value);
    case "string":
      return v.value;
    case "unparseable":
      return v.raw;
  }
}

interface Statement {
  subject: string;
  negated: boolean;
  object: string;
}

// Folded (already-normalized) representation of one side of a
// negation-conflict, used as a `conflictValueHash` input — distinct from
// `detail`, which only ever names the POSITIVE side's subject/object and so
// can't by itself distinguish which side was negated.
function statementKey(s: Statement): string {
  return `${s.subject}::${s.negated ? "not " : ""}${s.object}`;
}

function extractStatements(bodyText: string): Statement[] {
  const statements: Statement[] = [];
  for (const line of bodyText.split("\n")) {
    const m = NEGATION_LINE_RE.exec(line);
    if (!m) continue;
    const subject = m[1]!;
    const negation = m[2] ?? m[3]; // "not"/"no longer" (alt 1) or "isn't" (alt 2)
    const object = m[4]!;
    statements.push({
      subject: fold(subject),
      negated: negation !== undefined,
      object: fold(object),
    });
  }
  return statements;
}

/**
 * Precision-first heuristic contradiction detector. Owns extraction
 * internally (calls extract() on each side) since it needs the raw text for
 * negation-conflict detection (which reads body sentences directly).
 */
export class HeuristicDetector implements ContradictionDetector {
  detect(a: { text: string }, b: { text: string }): DetectedConflict[] {
    const conflicts: DetectedConflict[] = [];

    const factsA = extract(a.text);
    const factsB = extract(b.text);

    for (const [key, valueA] of factsA) {
      const valueB = factsB.get(key);
      if (!valueB) continue;
      if (valueA.type === "unparseable" || valueB.type === "unparseable") continue;
      if (valueA.type !== valueB.type) continue;
      if (valueA.value === valueB.value) continue;

      conflicts.push({
        kind: "value-conflict",
        factKey: key,
        detail: `${key}: "${displayValue(valueA)}" vs "${displayValue(valueB)}"`,
        values: [displayValue(valueA), displayValue(valueB)],
      });
    }

    const bodyA = matter(a.text).content;
    const bodyB = matter(b.text).content;
    const statementsA = extractStatements(bodyA);
    const statementsB = extractStatements(bodyB);

    for (const sa of statementsA) {
      for (const sb of statementsB) {
        if (sa.subject !== sb.subject) continue;
        if (sa.object !== sb.object) continue;
        if (sa.negated === sb.negated) continue; // need exactly one negated

        const [positive] = [sa, sb].filter((s) => !s.negated);
        if (!positive) continue;

        conflicts.push({
          kind: "negation-conflict",
          factKey: `${positive.subject}::${positive.object}`,
          detail: `"${positive.subject} is ${positive.object}" contradicted by negation`,
          values: [statementKey(sa), statementKey(sb)],
        });
      }
    }

    return conflicts;
  }
}
