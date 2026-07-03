import { createPatch } from "diff";

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
 *  - promote / forget: these aren't content edits at all (they flip a
 *    memory's status or archive its file), so a short human-readable
 *    description is returned instead of a patch.
 *  - anything else / malformed JSON: a defensive one-line description so a
 *    bad row never crashes the /approvals route.
 */
export function renderApprovalDiff(heldOperationJson: string): string {
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
      return patch ?? "(no patch present on held operation)";
    }
    case "create": {
      const path = typeof op.path === "string" ? op.path : "(unknown path)";
      const content = typeof op.content === "string" ? op.content : "";
      return createPatch(path, "", content);
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
