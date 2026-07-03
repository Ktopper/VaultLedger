import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import matter from "gray-matter";
import {
  assertContainedAndReadable,
  BrokerError,
  findStale,
  recall,
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
  INVALID_TRANSITION: 422,
  TARGET_EXISTS: 409,
  PATCH_TOO_LARGE: 400,
  SYNTAX_BREAK: 400,
  APPROVAL_REQUIRED: 400,
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

interface ErrorBody {
  error: { code: string; message: string; retriable?: boolean };
}

function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

/**
 * Build the fastify HTTP bridge over an already-open VaultContext (design
 * v0.2 §2, Phase 2). THIN adapter: every route delegates to core — no zone/
 * hash/patch logic lives here. A single global `preHandler` enforces two
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
 */
export function buildBridge(ctx: VaultContext, token: string): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const hostHeader = req.headers.host;
    if (!hostHeader || !isLoopbackHostname(extractHostname(hostHeader))) {
      await reply.code(403).send(errorBody("FORBIDDEN_ORIGIN", "request Host is not loopback"));
      return;
    }
    const originHeader = req.headers.origin;
    if (originHeader && !isLoopbackHostname(extractHostname(originHeader))) {
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

  app.get("/conflicts", async () => {
    return [];
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

  app.setErrorHandler((err: unknown, _req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof BrokerError) {
      const status = BROKER_ERROR_STATUS[err.code] ?? 400;
      void reply.code(status).send({ error: err.toRejection() });
      return;
    }
    // Never leak a raw stack — everything else is a generic 500.
    const message = err instanceof Error ? err.message : String(err);
    void reply.code(500).send({ error: { code: "INTERNAL", message } });
  });

  return app;
}
