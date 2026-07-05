/**
 * Pure DOM-building helpers for the Obsidian views (Task 4.2, design v0.2
 * Phase 4). Every function here builds nodes via `document.createElement` +
 * `.textContent` / `.classList` ONLY.
 *
 * SECURITY: `innerHTML` / `insertAdjacentHTML` / `outerHTML` are NEVER used
 * in this file. Diff bodies and provenance fields are attacker-influenced
 * content (an agent's proposed patch text, or frontmatter an agent wrote) —
 * assigning them via `innerHTML` would turn a hostile diff/note into script
 * execution inside Obsidian's renderer. `textContent` renders any string as
 * literal text, so this holds regardless of what the string contains. See
 * test/render.test.ts's "SECURITY" cases for the hostile-fixture proof.
 */

export interface ProvenanceInfo {
  source?: string;
  reason?: string;
  status?: string;
  confidence?: string;
  created?: string;
  expires?: string;
}

export interface SessionGroup<T> {
  session: string;
  txns: T[];
}

/** The minimal subset of a bridge `/conflicts` enriched item `renderConflict`
 * needs — kept structural/local rather than importing core's ConflictRow /
 * MemoryRow so this file stays a pure DOM-builder with zero value imports. */
export interface ConflictMemoryRef {
  id: string;
  path: string;
}

export interface ConflictInfo {
  row: {
    id: string;
    entity: string | null;
    kind: string | null;
    detail: string | null;
  };
  memoryA: ConflictMemoryRef | null;
  memoryB: ConflictMemoryRef | null;
}

/**
 * Render a unified-diff-style text blob as one `<div>` per line inside a
 * `<div class="vl-diff">`. Lines starting with `+`/`-` get an add/del class
 * for styling; everything else is context. Line content is set via
 * `textContent` only — never parsed or interpreted as markup.
 */
export function renderDiff(diffText: string): HTMLElement {
  const container = document.createElement("div");
  container.classList.add("vl-diff");

  for (const line of diffText.split("\n")) {
    const lineEl = document.createElement("div");
    if (line.startsWith("+")) {
      lineEl.classList.add("vl-diff-add");
    } else if (line.startsWith("-")) {
      lineEl.classList.add("vl-diff-del");
    } else {
      lineEl.classList.add("vl-diff-ctx");
    }
    lineEl.textContent = line;
    container.appendChild(lineEl);
  }

  return container;
}

const PROVENANCE_FIELDS: ReadonlyArray<[label: string, key: keyof ProvenanceInfo]> = [
  ["Source", "source"],
  ["Reason", "reason"],
  ["Status", "status"],
  ["Confidence", "confidence"],
  ["Created", "created"],
  ["Expires", "expires"],
];

/**
 * Render a small labeled-field summary of a note's ledger provenance
 * frontmatter. Only fields that are present are rendered; every label AND
 * value goes through `textContent`.
 */
export function renderProvenance(prov: ProvenanceInfo): HTMLElement {
  const container = document.createElement("div");
  container.classList.add("vl-provenance");

  for (const [label, key] of PROVENANCE_FIELDS) {
    const value = prov[key];
    if (value === undefined) continue;

    const row = document.createElement("div");
    row.classList.add("vl-provenance-field");

    const labelEl = document.createElement("span");
    labelEl.classList.add("vl-provenance-label");
    labelEl.textContent = `${label}: `;

    const valueEl = document.createElement("span");
    valueEl.classList.add("vl-provenance-value");
    valueEl.textContent = value;

    row.appendChild(labelEl);
    row.appendChild(valueEl);
    container.appendChild(row);
  }

  return container;
}

function memoryRefLabel(ref: ConflictMemoryRef | null): string {
  return ref ? `${ref.id} (${ref.path})` : "?";
}

/**
 * Render a single enriched conflict (a bridge `/conflicts` list item):
 * entity, kind, detail, and both memory sides' id/path. PURE, `textContent`
 * only — `detail`/`path` are attacker-influenced (drawn from an agent's
 * proposed note content), same contract as renderDiff/renderProvenance. See
 * test/render.test.ts's "SECURITY" case for the hostile-fixture proof.
 */
export function renderConflict(c: ConflictInfo): HTMLElement {
  const container = document.createElement("div");
  container.classList.add("vl-conflict");

  const header = document.createElement("div");
  header.classList.add("vl-conflict-header");
  header.textContent = `entity: ${c.row.entity ?? "?"}  kind: ${c.row.kind ?? "?"}`;
  container.appendChild(header);

  const detail = document.createElement("div");
  detail.classList.add("vl-conflict-detail");
  detail.textContent = c.row.detail ?? "";
  container.appendChild(detail);

  const memoryA = document.createElement("div");
  memoryA.classList.add("vl-conflict-memory-a");
  memoryA.textContent = `A: ${memoryRefLabel(c.memoryA)}`;
  container.appendChild(memoryA);

  const memoryB = document.createElement("div");
  memoryB.classList.add("vl-conflict-memory-b");
  memoryB.textContent = `B: ${memoryRefLabel(c.memoryB)}`;
  container.appendChild(memoryB);

  return container;
}

/**
 * Pure grouping of transactions (or anything session-tagged) by session,
 * preserving first-seen session order (not sorted, not re-ordered) so the
 * Agent Activity view can render sessions in the order they naturally
 * appear in the underlying (already time-ordered) transaction list.
 */
export function groupBySession<T extends { session: string }>(txns: T[]): Array<SessionGroup<T>> {
  const order: string[] = [];
  const bySession = new Map<string, T[]>();

  for (const txn of txns) {
    let group = bySession.get(txn.session);
    if (!group) {
      group = [];
      bySession.set(txn.session, group);
      order.push(txn.session);
    }
    group.push(txn);
  }

  return order.map((session) => ({ session, txns: bySession.get(session) as T[] }));
}
