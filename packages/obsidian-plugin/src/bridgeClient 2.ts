import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// Value imports come from the narrow "@vaultledger/core/config" subpath
// (fs/path only — no better-sqlite3/simple-git) rather than the package's
// main barrel: the barrel's "export *" chain pulls in journal/db.ts, which
// imports better-sqlite3's native addon. Bundled into main.js (this plugin's
// esbuild target), an unconditional top-level require of a native .node
// binary that isn't shipped alongside main.js would crash the plugin the
// instant Obsidian loads it. The type-only imports below are erased
// entirely at compile time (no runtime import at all), so they're safe to
// pull from the full barrel for its richer public type surface.
import { readConfig, vaultLockDir } from "@vaultledger/core/config";
import type {
  ApprovalRow,
  ListTransactionsFilters,
  MemoryRow,
  QueryMemoriesFilters,
  RecallResult,
  TransactionRow,
} from "@vaultledger/core";

/**
 * Thrown when the bridge cannot be reached at all: no discovery file, a
 * malformed one, or a real network failure talking to a bridge that's
 * supposedly running. This is distinct from a normal HTTP error response
 * (see `BridgeResult`) — it means there is no bridge to talk to, so the
 * caller (a view) should render a "start `ledger serve`" message rather than
 * an inline per-row error.
 */
export class BridgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeUnavailableError";
  }
}

/** The `{error}` body shape every non-2xx bridge response carries (see
 * `@vaultledger/server`'s `buildBridge` error handler / errorBody). */
export interface BridgeErrorBody {
  code: string;
  message: string;
  retriable?: boolean;
}

/**
 * Every typed BridgeClient call resolves to this discriminated union rather
 * than throwing on an EXPECTED rejection (a stale approval, an unknown id, a
 * bad token, ...) — the whole point is that views can render `error` inline
 * instead of wrapping every call in try/catch. Only a genuinely unreachable
 * bridge (see `BridgeUnavailableError`) throws.
 */
export type BridgeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: BridgeErrorBody; status: number };

export interface StatusResult {
  zones: Record<string, string[]>;
  mode: string;
  pendingApprovals: number;
  recentTransactions: TransactionRow[];
}

/** An approval row plus the rendered diff of its held operation (GET
 * /approvals shape — see `@vaultledger/server`'s render.ts). */
export type ApprovalWithDiff = ApprovalRow & { diff: string };

export interface ProvenanceResult {
  path: string;
  ledger: unknown;
}

export type ApproveResponse = { applied: true } | { stale: true };

export type UndoResponse =
  | { revertSha: string; revertTxnId: string }
  | { reverted: Array<{ txnId: string; revertSha: string }> };

interface BridgeFile {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

function isBridgeFile(value: unknown): value is BridgeFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<BridgeFile>;
  return (
    typeof v.port === "number" &&
    typeof v.token === "string" &&
    typeof v.pid === "number" &&
    typeof v.startedAt === "string"
  );
}

/** Build a `?k=v&...` query string, dropping undefined values. Returns "" if
 * there are no defined params, so callers can always just append the result. */
function toQueryString(params?: Record<string, string | number | undefined>): string {
  if (!params) return "";
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) usp.set(key, String(value));
  }
  const qs = usp.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Thin HTTP client over the `ledger serve` bridge (design v0.2 Phase 4). No
 * business logic lives here — every method is a direct, typed call to one
 * bridge route. Two failure shapes, deliberately distinguished:
 *
 *  - an EXPECTED rejection (bad token, unknown id, a stale approval, a
 *    forbidden zone, ...) comes back as `{ok:false, error, status}` so a view
 *    can render it inline without a try/catch around every call;
 *  - the bridge being unreachable at all (not running, discovery file
 *    missing/corrupt, a real network failure) throws `BridgeUnavailableError`
 *    — there is nothing sensible to render per-row for that, the whole view
 *    needs a "start `ledger serve`" message instead.
 */
/** Default per-request timeout (ms). A bridge process that's alive but
 * wedged (never replies) would otherwise hang a view's refresh forever —
 * `fetch` only rejects on an *immediate* network failure, not a stall. */
const DEFAULT_TIMEOUT_MS = 5000;

/** Injectable dependencies for testability — a fake fetch and/or a shorter
 * timeout so the timeout path can be exercised deterministically without a
 * real 5s wait. `fetch` defaults to the global; `timeoutMs` to 5000. */
export interface BridgeClientDeps {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class BridgeClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    deps?: BridgeClientDeps,
  ) {
    // Bind to globalThis so a default `fetch` isn't called with the wrong
    // `this` (undici's fetch throws "Illegal invocation" otherwise).
    this.fetchImpl = deps?.fetch ?? fetch.bind(globalThis);
    this.timeoutMs = deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Discover a running bridge for `vaultRoot` the same way every host must:
   * read `.ledger/config.json` (core's `readConfig`) for the vaultId, then
   * `<app-support>/<vaultId>/bridge.json` (core's `vaultLockDir`) for
   * `{port, token}`. Reusing those two core helpers (rather than
   * re-deriving the path) is what guarantees this lines up EXACTLY with
   * where `ledger serve` (packages/cli's serveCommand) publishes it.
   */
  static async fromVault(
    vaultRoot: string,
    deps?: { env?: NodeJS.ProcessEnv } & BridgeClientDeps,
  ): Promise<BridgeClient> {
    const { vaultId } = readConfig(vaultRoot);
    const bridgePath = join(vaultLockDir(vaultId, deps?.env), "bridge.json");

    if (!existsSync(bridgePath)) {
      throw new BridgeUnavailableError("bridge not running — run `ledger serve`");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(bridgePath, "utf8"));
    } catch (e) {
      throw new BridgeUnavailableError(
        `bridge discovery file unreadable at ${bridgePath}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (!isBridgeFile(parsed)) {
      throw new BridgeUnavailableError(`bridge discovery file malformed at ${bridgePath}`);
    }

    return new BridgeClient(`http://127.0.0.1:${parsed.port}`, parsed.token, {
      fetch: deps?.fetch,
      timeoutMs: deps?.timeoutMs,
    });
  }

  /**
   * Shared fetch + response-shaping path every typed method funnels through.
   * A network-level failure (bridge process down, port unreachable, ...) OR a
   * timeout (bridge alive but wedged, never replying within `timeoutMs`)
   * throws `BridgeUnavailableError` — that's the ONE place in this class a
   * throw is the right contract, since it means there is no response at all
   * to shape into a `BridgeResult`. The timeout is enforced via
   * `AbortSignal.timeout`, so a hung bridge fails a view's refresh in bounded
   * time instead of hanging it forever.
   */
  private async request<T>(path: string, init?: RequestInit): Promise<BridgeResult<T>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          ...init?.headers,
        },
      });
    } catch (e) {
      // A timeout surfaces as an AbortError (name "AbortError" / "TimeoutError"
      // depending on runtime) — fold it into the same unreachable-bridge
      // contract, with a message that names the stall specifically.
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new BridgeUnavailableError(
          `bridge timed out after ${this.timeoutMs}ms at ${this.baseUrl} — the bridge process may be wedged`,
        );
      }
      throw new BridgeUnavailableError(
        `could not reach the VaultLedger bridge at ${this.baseUrl}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (res.ok) {
      const data = (await res.json()) as T;
      return { ok: true, data };
    }

    let body: { error?: Partial<BridgeErrorBody> } = {};
    try {
      body = (await res.json()) as { error?: Partial<BridgeErrorBody> };
    } catch {
      // Non-JSON (or empty) error body — fall through to a generic error
      // below rather than letting a parse failure mask the real HTTP status.
    }
    const error: BridgeErrorBody = {
      code: body.error?.code ?? "UNKNOWN",
      message: body.error?.message ?? res.statusText ?? "request failed",
      retriable: body.error?.retriable,
    };
    return { ok: false, error, status: res.status };
  }

  status(): Promise<BridgeResult<StatusResult>> {
    return this.request<StatusResult>("/status");
  }

  approvals(): Promise<BridgeResult<ApprovalWithDiff[]>> {
    return this.request<ApprovalWithDiff[]>("/approvals");
  }

  transactions(filters?: ListTransactionsFilters): Promise<BridgeResult<TransactionRow[]>> {
    const qs = toQueryString(filters as Record<string, string | number | undefined> | undefined);
    return this.request<TransactionRow[]>(`/transactions${qs}`);
  }

  memories(filters?: QueryMemoriesFilters): Promise<BridgeResult<RecallResult[]>> {
    const qs = toQueryString(filters as Record<string, string | number | undefined> | undefined);
    return this.request<RecallResult[]>(`/memories${qs}`);
  }

  staleness(): Promise<BridgeResult<MemoryRow[]>> {
    return this.request<MemoryRow[]>("/staleness");
  }

  conflicts(): Promise<BridgeResult<unknown[]>> {
    return this.request<unknown[]>("/conflicts");
  }

  provenance(path: string): Promise<BridgeResult<ProvenanceResult>> {
    const qs = toQueryString({ path });
    return this.request<ProvenanceResult>(`/provenance${qs}`);
  }

  approve(id: string): Promise<BridgeResult<ApproveResponse>> {
    return this.request<ApproveResponse>(`/approvals/${encodeURIComponent(id)}/approve`, { method: "POST" });
  }

  reject(id: string): Promise<BridgeResult<{ rejected: true }>> {
    return this.request<{ rejected: true }>(`/approvals/${encodeURIComponent(id)}/reject`, { method: "POST" });
  }

  undo(target: string): Promise<BridgeResult<UndoResponse>> {
    return this.request<UndoResponse>("/undo", {
      method: "POST",
      body: JSON.stringify({ target }),
    });
  }
}
