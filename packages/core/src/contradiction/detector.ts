import matter from "gray-matter";
import { extract } from "./extract.js";
import type { CanonicalValue } from "./extract.js";

export type ConflictKind = "value-conflict" | "negation-conflict";

export interface DetectedConflict {
  kind: ConflictKind;
  factKey: string;
  detail: string;
}

export interface ContradictionDetector {
  detect(a: { text: string }, b: { text: string }): DetectedConflict[];
}

// Simple declarative statement: "<subject> is [not|no longer|isn't] <object>".
// Exact normalized subject+object match only — no fuzzy matching. Intentionally
// narrow: one "X is Y" clause per line; compound sentences (multiple clauses /
// conjunctions) are scoped out by design to keep precision high.
const NEGATION_LINE_RE = /^\s*(.+?)\s+is\s+(not\s+|no longer\s+|isn't\s+)?(.+?)\s*$/i;

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

function extractStatements(bodyText: string): Statement[] {
  const statements: Statement[] = [];
  for (const line of bodyText.split("\n")) {
    const m = NEGATION_LINE_RE.exec(line);
    if (!m) continue;
    const subject = m[1]!;
    const negation = m[2];
    const object = m[3]!;
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
        });
      }
    }

    return conflicts;
  }
}
