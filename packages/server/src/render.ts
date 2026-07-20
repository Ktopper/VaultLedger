import { createPatch } from "diff";

/** Max characters of a rendered approval diff returned to the client. A
 * queued propose_edit's held patch is caller-supplied and unbounded, and
 * `/approvals` renders EVERY pending row on every call — one oversized diff
 * would otherwise bloat the whole response. Anything longer is truncated
 * with a trailing marker; the reviewer can still open the note to see the
 * full change. */
export const DIFF_RENDER_LIMIT = 20_000;

const TRUNCATION_MARKER = "\n…(truncated)";

/** Cap a rendered diff at DIFF_RENDER_LIMIT chars, appending a marker when
 * truncated. */
function capDiff(rendered: string): string {
  if (rendered.length <= DIFF_RENDER_LIMIT) return rendered;
  return rendered.slice(0, DIFF_RENDER_LIMIT) + TRUNCATION_MARKER;
}

/** Options widening `renderApprovalDiff` beyond the self-contained held op.
 * A `propose_delete` op carries NO content (the broker queues only the path +
 * hash pin), so the current on-disk bytes have to be supplied by the caller —
 * the `/approvals` handler reads them (bounded) and passes them here. */
export interface RenderApprovalOpts {
  /** Current on-disk content of a `propose_delete` target, read by the
   * `/approvals` handler under the same containment gate the broker uses,
   * bounded to ≤64 KiB. Left undefined when the op isn't a delete, or when the
   * read failed for ANY reason (already absent / over-cap / non-text): render
   * then emits an `— <path> unavailable` marker instead of throwing, so one
   * unreadable row can't 500 the route that loops over every pending row. */
  deleteContent?: string;
}

/**
 * Render a human-reviewable plain-text diff for a held (queued) operation, so
 * the Obsidian plugin's approval UI can show a reviewer exactly what a
 * pending approval would do without re-deriving diff logic client-side.
 *
 *  - revise / propose_edit: the held operation already carries a unified
 *    diff (`.patch`, produced by the broker/store when it queued the op) —
 *    returned as-is.
 *  - create: there is no patch (the op writes brand-new content), so a
 *    unified diff is synthesized from "" -> content via `diff`'s
 *    `createPatch`, matching the same diff engine the broker/store already
 *    depend on.
 *  - propose_delete: the held op has no content, so the caller supplies the
 *    current bytes via `opts.deleteContent`. Rendered as a `DELETE <path>`
 *    header plus every content line as a `-` removal (the mirror of create's
 *    "" -> content, run content -> ""). A missing/unreadable source (see
 *    RenderApprovalOpts) renders an `— <path> unavailable` marker.
 *  - propose_move: bytes are unchanged, so there's no diff body — just a
 *    `MOVE <from> -> <to>` line naming the rename.
 *  - promote / forget: these aren't content edits at all (they flip a
 *    memory's status or archive its file), so a short human-readable
 *    description is returned instead of a patch.
 *  - anything else / malformed JSON: a defensive one-line description so a
 *    bad row never crashes the /approvals route.
 */
export function renderApprovalDiff(heldOperationJson: string, opts?: RenderApprovalOpts): string {
  let op: Record<string, unknown>;
  try {
    op = JSON.parse(heldOperationJson) as Record<string, unknown>;
  } catch {
    return "(unreadable held operation)";
  }

  const opName = typeof op.op === "string" ? op.op : undefined;
  switch (opName) {
    case "revise":
    case "propose_edit": {
      const patch = typeof op.patch === "string" ? op.patch : undefined;
      return capDiff(patch ?? "(no patch present on held operation)");
    }
    case "create": {
      const path = typeof op.path === "string" ? op.path : "(unknown path)";
      const content = typeof op.content === "string" ? op.content : "";
      return capDiff(createPatch(path, "", content));
    }
    case "propose_delete": {
      const path = typeof op.path === "string" ? op.path : "(unknown path)";
      const content = opts?.deleteContent;
      // N1: the handler couldn't read the current bytes (absent/over-cap/
      // non-text) — never throw; show the reviewer a marker so the loop over
      // every pending row keeps rendering.
      if (typeof content !== "string") {
        return `— ${path} unavailable`;
      }
      // DELETE header + the full content as `-` removal lines (mirror of the
      // create branch's "" -> content, run content -> "").
      const body = content
        .split("\n")
        .map((line) => `-${line}`)
        .join("\n");
      return capDiff(`DELETE ${path}\n${body}`);
    }
    case "propose_move": {
      const from = typeof op.from === "string" ? op.from : "(unknown source)";
      const to = typeof op.to === "string" ? op.to : "(unknown destination)";
      // Bytes are unchanged across a move, so there's no diff body.
      return `MOVE ${from} -> ${to}`;
    }
    case "promote": {
      const id = typeof op.id === "string" ? op.id : "(unknown id)";
      const target = typeof op.target_status === "string" ? op.target_status : "(unknown status)";
      return `promote memory ${id} -> status "${target}"`;
    }
    case "forget": {
      const id = typeof op.id === "string" ? op.id : "(unknown id)";
      return `forget (archive) memory ${id}`;
    }
    default:
      return `(unrecognized held operation: ${String(opName)})`;
  }
}
