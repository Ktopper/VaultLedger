import { BrokerError, type ApprovalRow } from "@vaultledger/core";
import { createPatch } from "diff";
import { loadContext, type LoadContextDeps } from "../context.js";

export interface ApproveOptions {
  id?: string;
  reject?: boolean;
  out?: (s: string) => void;
  /** Colorize the rendered diff with ANSI codes. Defaults to off so tests
   * (and any non-tty consumer) get stable plain text. */
  color?: boolean;
}

export type ApproveCommandResult =
  | ApprovalRow[]
  | { applied: true }
  | { stale: true }
  | { rejected: true }
  | { ok: false; code: string };

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function colorizeDiff(patchText: string): string {
  return patchText
    .split("\n")
    .map((line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) return `${GREEN}${line}${RESET}`;
      if (line.startsWith("-") && !line.startsWith("---")) return `${RED}${line}${RESET}`;
      return line;
    })
    .join("\n");
}

/** Render a held operation's diff. `create`/`revise`/`propose_edit` ops carry
 * (or can derive) a unified diff; `promote` has no file diff, just a status
 * transition to describe. */
function renderHeldOperation(op: Record<string, unknown>): string {
  if (typeof op.patch === "string") {
    return op.patch;
  }
  if (op.op === "create" && typeof op.content === "string" && typeof op.path === "string") {
    return createPatch(op.path, "", op.content as string);
  }
  if (op.op === "promote") {
    return `(no file diff) promote memory ${op.id as string} -> ${op.target_status as string}`;
  }
  return "(no diff available)";
}

function renderApproval(approval: ApprovalRow, color: boolean): string {
  const op = JSON.parse(approval.held_operation) as Record<string, unknown>;
  const target = typeof op.path === "string" ? op.path : typeof op.id === "string" ? op.id : "?";
  const header =
    `[${approval.id}] op=${String(op.op)} target=${target} zone=${approval.zone} ` +
    `reason=${approval.reason ?? ""} session=${approval.session}`;
  const diffText = renderHeldOperation(op);
  return `${header}\n${color ? colorizeDiff(diffText) : diffText}`;
}

/**
 * Thin adapter over `Approvals`:
 *  - no id: list every pending approval with a rendered diff.
 *  - id, no reject: approve it (applies the held op, or reports "stale" if
 *    the underlying hash moved since it was queued).
 *  - id + reject: reject it.
 * Any BrokerError is caught, printed as `code: message`, and returned as
 * `{ ok: false, code }` rather than thrown — the commander wrapper decides
 * exit-code semantics, not this testable function.
 */
export async function approveCommand(
  vaultDir: string,
  opts: ApproveOptions = {},
  deps?: LoadContextDeps,
): Promise<ApproveCommandResult> {
  const out = opts.out ?? console.log;
  const ctx = await loadContext(vaultDir, deps);
  try {
    if (!opts.id) {
      const pending = ctx.approvals.list();
      if (pending.length === 0) {
        out("(no pending approvals)");
      }
      for (const approval of pending) {
        out(renderApproval(approval, opts.color ?? false));
      }
      return pending;
    }

    try {
      if (opts.reject) {
        ctx.approvals.reject(opts.id);
        out(`rejected ${opts.id}`);
        return { rejected: true };
      }

      const result = await ctx.approvals.approve(opts.id);
      if ("stale" in result) {
        out(`approval ${opts.id} is stale (underlying hash changed since it was queued)`);
      } else {
        out(`applied approval ${opts.id}`);
      }
      return result;
    } catch (e) {
      if (e instanceof BrokerError) {
        out(`${e.code}: ${e.message}`);
        return { ok: false, code: e.code };
      }
      throw e;
    }
  } finally {
    ctx.db.close();
  }
}
