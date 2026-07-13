import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import matter from "gray-matter";
import {
  assertContainedAndReadable,
  BrokerError,
  Conflicts,
  findStale,
  recall,
  undoSession,
  undoTransaction,
  type RejectionCode,
  type VaultContext,
} from "@vaultledger/core";
import { renderApprovalDiff } from "./render.js";

/**
 * BrokerError.code -> HTTP status (Task 2.4's contract, wired here already
 * because /provenance — Task 2.3 — is the first route that can throw a
 * BrokerError (FORBIDDEN_ZONE) and needs it mapped to a real HTTP status
 * rather than leaking as a generic 500). This table is exhaustive over
 * every RejectionCode so a future route throwing any core BrokerError maps
 * correctly without touching this file again.
 */
const BROKER_ERROR_STATUS: Record<RejectionCode, number> = {
  FORBIDDEN_ZONE: 403,
  NOT_FOUND: 404,
  STALE_HASH: 409,
  REVERT_CONFLICT: 409,
  ALREADY_REVERTED: 409,
  ALREADY_CLOSED: 409,
  INVALID_TRANSITION: 422,
  TARGET_EXISTS: 409,
  PATCH_TOO_LARGE: 400,
  SYNTAX_BREAK: 400,
  APPROVAL_REQUIRED: 400,
  // Governance refusal (ledger-block tamper guard), same family as
  // FORBIDDEN_ZONE / APPROVAL_REQUIRED.
  LEDGER_GUARD: 403,
  // A malformed expected_hash is a caller input error, not a state
  // conflict -- 400, same family as PATCH_TOO_LARGE/SYNTAX_BREAK.
  MALFORMED_HASH: 400,
  // A distillation citing a bad source (missing/forgotten/empty) is a
  // caller input error about the request's shape, not a state conflict --
  // same family as INVALID_TRANSITION.
  INVALID_SOURCE: 422,
  // scanVault's self-check (VL-SEC-S7-03 fix): thrown only from `ledger
  // init`/`setup` (CLI-side, not reachable through any server route today)
  // when the proposed manifest would fail to exclude a detected Private
  // folder. Included here only for Record<RejectionCode, number>
  // exhaustiveness -- 500 because it signals an internal invariant the tool
  // failed to uphold, not a client-caused rejection.
  INVARIANT_VIOLATION: 500,
};

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Extract the hostname portion of a `Host`/`Origin`-ish header value,
 * stripping a port (`host:port`) and scheme (`http://host:port`) if
 * present. IPv6 literals arrive bracketed (`[::1]:1234`) — handled
 * separately since `hostname:port` splitting on the last `:` would mangle
 * them. */
function extractHostname(value: string): string {
  let v = value.trim();
  // Strip a scheme, e.g. "http://127.0.0.1:51789" (Origin headers include one).
  const schemeIdx = v.indexOf("://");
  if (schemeIdx !== -1) {
    v = v.slice(schemeIdx + 3);
  }
  if (v.startsWith("[")) {
    // Bracketed IPv6 literal, optionally followed by :port.
    const end = v.indexOf("]");
    return end === -1 ? v : v.slice(0, end + 1);
  }
  const colonIdx = v.indexOf(":");
  return colonIdx === -1 ? v : v.slice(0, colonIdx);
}

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/**
 * Pure loopback check over a raw `Host`/`Origin` header value, extracted so
 * it's unit-testable directly (the missing-Host branch in particular can't
 * be exercised via `fastify.inject`, which always injects a default Host).
 * `undefined`/empty -> false (a request with no Host header is not trusted).
 * A rebinding attempt that merely embeds the loopback IP as a label of a
 * public hostname (e.g. `127.0.0.1.evil.com`) is NOT loopback: the extracted
 * hostname is the full string, which isn't in the exact loopback set.
 */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  return isLoopbackHostname(extractHostname(hostHeader));
}

interface ErrorBody {
  error: { code: string; message: string; retriable?: boolean };
}

function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

/**
 * Build the fastify HTTP bridge over an already-open VaultContext (design
 * v0.2 §2, Phase 2). THIN adapter: every route delegates to core — no zone/
 * hash/patch logic lives here. A single global `onRequest` hook enforces two
 * independent guards before any route runs:
 *
 *  1. Loopback guard: the request's `Host` (and, if present, `Origin`)
 *     header must resolve to a loopback hostname. The bridge is meant to be
 *     reachable only from the same machine (the Obsidian plugin's renderer
 *     process) — a non-loopback Host means either a misconfigured reverse
 *     proxy or a DNS-rebinding attempt, both of which must be rejected
 *     before touching the vault.
 *  2. Bearer token auth, compared with `timingSafeEqual` (length-guarded
 *     first, since `timingSafeEqual` throws on a length mismatch rather
 *     than returning false) so a wrong-length guess doesn't short-circuit
 *     the comparison in a way that leaks timing information.
 *
 * The guard runs in `onRequest` — NOT `preHandler` — deliberately: onRequest
 * fires before Fastify's body-parsing phase, so a malformed/oversized body
 * from an unauthenticated or non-loopback caller is rejected by the guard
 * BEFORE it ever reaches the JSON parser. A preHandler guard runs AFTER
 * parsing, which would let a bad body trip the parser (and the error
 * handler) without ever passing the gate — a real bypass of the "single
 * global gate before any route runs" invariant.
 */
// APP-level bodyLimit (not per-route): covers every route on this instance,
// including any future mutation route (e.g. /conflicts/:id/resolve), without
// needing to remember to set it again per-route. 16 KiB comfortably covers
// every real payload this bridge accepts today (a patch diff for a single
// note edit, an undo target id) while bounding how much a request body can
// make Fastify buffer before the loopback+auth guard (which runs in
// onRequest, BEFORE body parsing) even gets a chance to reject it.
const BODY_LIMIT_BYTES = 16 * 1024;

export function buildBridge(ctx: VaultContext, token: string): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES });

  // Some mutation routes (approve/reject) take no body at all; a real client
  // may still send `Content-Type: application/json` on a bodyless POST.
  // Fastify's default JSON parser rejects an empty body outright — override
  // it to treat empty as `{}` rather than 500ing on a perfectly normal
  // request shape.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req: FastifyRequest, body: string, done: (err: Error | null, result?: unknown) => void) => {
      if (body.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body));
      } catch (e) {
        // A malformed JSON body is a CLIENT error (400), not a server fault.
        // The raw JSON.parse SyntaxError carries no statusCode, so annotate
        // it — the error handler honors err.statusCode for a 4xx and would
        // otherwise mislabel this as a 500.
        const err = e as Error & { statusCode?: number };
        err.statusCode = 400;
        done(err, undefined);
      }
    },
  );

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isLoopbackHost(req.headers.host)) {
      await reply.code(403).send(errorBody("FORBIDDEN_ORIGIN", "request Host is not loopback"));
      return;
    }
    const originHeader = req.headers.origin;
    if (originHeader && !isLoopbackHost(originHeader)) {
      await reply.code(403).send(errorBody("FORBIDDEN_ORIGIN", "request Origin is not loopback"));
      return;
    }

    const authHeader = req.headers.authorization;
    const prefix = "Bearer ";
    const provided = authHeader && authHeader.startsWith(prefix) ? authHeader.slice(prefix.length) : undefined;
    if (provided === undefined) {
      await reply.code(401).send(errorBody("UNAUTHORIZED", "missing bearer token"));
      return;
    }
    const providedBuf = Buffer.from(provided, "utf8");
    const tokenBuf = Buffer.from(token, "utf8");
    const authorized = providedBuf.length === tokenBuf.length && timingSafeEqual(providedBuf, tokenBuf);
    if (!authorized) {
      await reply.code(401).send(errorBody("UNAUTHORIZED", "invalid bearer token"));
      return;
    }
  });

  app.get("/status", async () => {
    return {
      zones: ctx.manifest.zones,
      mode: ctx.manifest.mode,
      pendingApprovals: ctx.approvals.list().length,
      recentTransactions: ctx.journal.listTransactions({ limit: 10 }),
    };
  });

  app.get("/approvals", async () => {
    return ctx.approvals.list().map((row) => ({
      ...row,
      diff: renderApprovalDiff(row.held_operation),
    }));
  });

  app.get("/transactions", async (req: FastifyRequest) => {
    const query = req.query as { session?: string; entity?: string; limit?: string };
    const limit = query.limit !== undefined ? Number.parseInt(query.limit, 10) : 20;
    return ctx.journal.listTransactions({
      session: query.session,
      entity: query.entity,
      limit,
    });
  });

  app.get("/memories", async (req: FastifyRequest) => {
    const query = req.query as { entity?: string; status?: string; tag?: string };
    return recall(ctx.journal, { entity: query.entity, status: query.status, tag: query.tag }, ctx.now);
  });

  app.get("/staleness", async () => {
    const workingMemories = ctx.journal.queryMemories({ status: "working" });
    const staleIds = new Set(findStale(workingMemories, ctx.now, ctx.config.stalenessDays));
    return workingMemories.filter((m) => staleIds.has(m.id));
  });

  // Journal-only, lock-free: conflicts live entirely in the disposable
  // sqlite journal (never the vault/git), so resolving/dismissing one never
  // needs the broker's cross-process vault lock.
  app.get("/conflicts", async () => {
    return new Conflicts(ctx.journal).list("open");
  });

  app.post("/conflicts/:id/resolve", async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const conflicts = new Conflicts(ctx.journal);
    if (!conflicts.get(id)) {
      throw new BrokerError("NOT_FOUND", `no conflict with id ${id}`);
    }
    conflicts.resolve(id, ctx.now());
    return { resolved: true };
  });

  app.post("/conflicts/:id/dismiss", async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const conflicts = new Conflicts(ctx.journal);
    if (!conflicts.get(id)) {
      throw new BrokerError("NOT_FOUND", `no conflict with id ${id}`);
    }
    conflicts.dismiss(id, ctx.now());
    return { dismissed: true };
  });

  // SECURITY (Task 2.3): reuses the EXACT SAME containment + zone-exclusion
  // gate the broker enforces on writes (assertContainedAndReadable, shared
  // via core's broker/containment.ts) so this read-only route can never leak
  // an excluded-zone note's frontmatter, a traversal path, or a
  // symlink-escape target — it throws BrokerError FORBIDDEN_ZONE for all
  // three, mapped to 403 by the error handler below.
  app.get("/provenance", async (req: FastifyRequest) => {
    const query = req.query as { path?: string };
    const relPath = query.path ?? "";
    const abs = assertContainedAndReadable(ctx.vaultRoot, ctx.manifest, relPath);
    if (!existsSync(abs)) {
      throw new BrokerError("NOT_FOUND", `no note at ${relPath}`);
    }
    const content = readFileSync(abs, "utf8");
    const parsed = matter(content);
    const ledger = parsed.data.ledger ?? null;
    return { path: relPath, ledger };
  });

  app.post("/approvals/:id/approve", async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return ctx.approvals.approve(id);
  });

  app.post("/approvals/:id/reject", async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    ctx.approvals.reject(id);
    return { rejected: true };
  });

  // MUST thread ctx.lockDir into the undo deps so this bridge's undo
  // mutually excludes with any other host (MCP server, CLI) mutating the
  // same vault via the same lockDir (concurrency correctness).
  app.post("/undo", async (req: FastifyRequest) => {
    const body = (req.body ?? {}) as { target?: string };
    const target = body.target ?? "";
    const undoDeps = {
      git: ctx.git,
      journal: ctx.journal,
      now: ctx.now,
      genId: ctx.genId,
      lockDir: ctx.lockDir,
    };
    if (target.startsWith("session:")) {
      const reverted = await undoSession(undoDeps, target.slice("session:".length));
      return { reverted };
    }
    return undoTransaction(undoDeps, target);
  });

  app.setErrorHandler((err: unknown, _req: FastifyRequest, reply: FastifyReply) => {
    // BrokerError: the intended machine-readable rejection — keep its real
    // code + message and map its code to the right HTTP status.
    if (err instanceof BrokerError) {
      const status = BROKER_ERROR_STATUS[err.code] ?? 400;
      void reply.code(status).send({ error: err.toRejection() });
      return;
    }

    // Non-BrokerError: honor Fastify's own `statusCode` when it's a genuine
    // CLIENT error (a malformed body is 400, an unsupported content-type is
    // 415, ...) — forcing every such case to 500 would mislabel the caller's
    // mistake as a server fault. A 4xx client error is safe to surface with
    // its (Fastify-generated, non-sensitive) message.
    const statusCode = (err as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
      const message = err instanceof Error ? err.message : String(err);
      void reply.code(statusCode).send({ error: { code: "BAD_REQUEST", message } });
      return;
    }

    // A genuine internal (5xx) error: log the real detail SERVER-SIDE only
    // (logger is disabled on this instance), and return a FIXED generic
    // message — never echo err.message to the client, since it can carry fs
    // paths or library internals.
    console.error("vaultledger bridge: internal error", err);
    void reply.code(500).send({ error: { code: "INTERNAL", message: "internal error" } });
  });

  return app;
}
