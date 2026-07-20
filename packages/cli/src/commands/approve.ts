import { readFileSync, statSync } from "node:fs";
import {
  assertContainedAndReadable,
  BrokerError,
  type ApprovalRow,
  type PermissionsManifest,
} from "@vault-ledger/core";
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

// Cap how much of a proposed diff we dump to the terminal. A `create` proposal
// can carry an arbitrarily large (or binary) body; rendering it whole would
// flood the console. Patches (revise/propose_edit) are already bounded by the
// broker's patch-size guard, so only the derived `create` diff needs a cap.
const MAX_RENDERED_DIFF_CHARS = 4_000;

function truncateDiff(text: string): string {
  if (text.length <= MAX_RENDERED_DIFF_CHARS) return text;
  return `${text.slice(0, MAX_RENDERED_DIFF_CHARS)}\n… [truncated ${text.length - MAX_RENDERED_DIFF_CHARS} more chars]`;
}

/** The minimal vault handle renderHeldOperation needs to read a propose_delete
 * target's current bytes — the same containment gate the broker enforces. */
export interface RenderVault {
  vaultRoot: string;
  manifest: PermissionsManifest;
}

// Ceiling on how many bytes of a to-be-deleted note we read to render its
// removal diff. A propose_delete carries no content, so the current on-disk
// bytes are read here; an oversized source is treated as unavailable (same
// spirit as MAX_RENDERED_DIFF_CHARS bounding a rendered patch).
const DELETE_RENDER_MAX_BYTES = 64 * 1024;

/** Read the current bytes of a propose_delete target so its removal can be
 * shown. Returns undefined (→ an `unavailable` marker, NEVER a throw) for any
 * read failure: excluded/traversal (assertContainedAndReadable throws), absent,
 * not-a-file, over-cap, or non-UTF-8 (binary). */
function readDeleteContent(vault: RenderVault, relPath: string): string | undefined {
  try {
    const abs = assertContainedAndReadable(vault.vaultRoot, vault.manifest, relPath);
    const stat = statSync(abs);
    if (!stat.isFile() || stat.size > DELETE_RENDER_MAX_BYTES) return undefined;
    const buf = readFileSync(abs);
    const text = buf.toString("utf8");
    if (Buffer.byteLength(text, "utf8") !== buf.length) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

/** Render a held operation's diff. `create`/`revise`/`propose_edit` ops carry
 * (or can derive) a unified diff; `propose_delete` has no content on the held
 * op, so the current on-disk bytes are read (bounded) and shown as a `DELETE`
 * header + `-` removal lines; `propose_move` is byte-preserving, so just the
 * `MOVE from -> to` rename; `promote` has no file diff, just a status
 * transition to describe. */
function renderHeldOperation(op: Record<string, unknown>, vault: RenderVault): string {
  if (typeof op.patch === "string") {
    return op.patch;
  }
  if (op.op === "create" && typeof op.content === "string" && typeof op.path === "string") {
    return truncateDiff(createPatch(op.path, "", op.content as string));
  }
  if (op.op === "propose_delete" && typeof op.path === "string") {
    const content = readDeleteContent(vault, op.path);
    // Read failure of any kind → a marker, never a throw (mirrors the server's
    // N1 handling so `ledger approve` never crashes on one unreadable row).
    if (content === undefined) return `— ${op.path} unavailable`;
    const body = content
      .split("\n")
      .map((line) => `-${line}`)
      .join("\n");
    return truncateDiff(`DELETE ${op.path}\n${body}`);
  }
  if (op.op === "propose_move" && typeof op.from === "string" && typeof op.to === "string") {
    return `MOVE ${op.from} -> ${op.to}`;
  }
  if (op.op === "promote") {
    return `(no file diff) promote memory ${op.id as string} -> ${op.target_status as string}`;
  }
  return "(no diff available)";
}

function renderApproval(approval: ApprovalRow, color: boolean, vault: RenderVault): string {
  const op = JSON.parse(approval.held_operation) as Record<string, unknown>;
  const target = typeof op.path === "string" ? op.path : typeof op.id === "string" ? op.id : "?";
  const header =
    `[${approval.id}] op=${String(op.op)} target=${target} zone=${approval.zone} ` +
    `reason=${approval.reason ?? ""} session=${approval.session}`;
  const diffText = renderHeldOperation(op, vault);
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
      const vault: RenderVault = { vaultRoot: ctx.vaultRoot, manifest: ctx.manifest };
      for (const approval of pending) {
        out(renderApproval(approval, opts.color ?? false, vault));
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
