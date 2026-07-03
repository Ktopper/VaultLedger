import { afterEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildBridge } from "../src/app.js";
import { makeTestVault, openTestVault, type TestVault } from "./helpers.js";

const TOKEN = "test-token-123";
const HEADERS = { host: "127.0.0.1:51789", authorization: `Bearer ${TOKEN}` };

let vault: TestVault | undefined;
let app: FastifyInstance | undefined;
let closeCtx: (() => void) | undefined;
let extraCleanup: (() => void) | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  if (closeCtx) {
    closeCtx();
    closeCtx = undefined;
  }
  if (extraCleanup) {
    extraCleanup();
    extraCleanup = undefined;
  }
  if (vault) {
    vault.cleanup();
    vault = undefined;
  }
});

describe("GET /provenance (zone-checked)", () => {
  test("a real remembered memory returns 200 with its ledger frontmatter block", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();
    const { id, path } = await ctx.store.remember({
      content: "# a fact\n",
      reason: "seed",
      session: "s1",
    });

    app = buildBridge(ctx, TOKEN);
    const res = await app.inject({
      method: "GET",
      url: `/provenance?path=${encodeURIComponent(path)}`,
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBe(path);
    expect(body.ledger).toBeTruthy();
    expect(body.ledger.id).toBe(id);
    expect(body.ledger.status).toBe("scratch");
  });

  test("a note with no ledger frontmatter returns { ledger: null }", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();

    app = buildBridge(ctx, TOKEN);
    const res = await app.inject({
      method: "GET",
      url: `/provenance?path=${encodeURIComponent("Notes/trusted.md")}`,
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ path: "Notes/trusted.md", ledger: null });
  });

  test("an excluded-zone path (Private/**) is rejected 403 FORBIDDEN_ZONE, not leaked", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();
    mkdirSync(join(vault.vaultDir, "Private"), { recursive: true });
    writeFileSync(join(vault.vaultDir, "Private", "secret.md"), "---\nledger:\n  secret: true\n---\ntop secret\n", "utf8");

    app = buildBridge(ctx, TOKEN);
    const res = await app.inject({
      method: "GET",
      url: `/provenance?path=${encodeURIComponent("Private/secret.md")}`,
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "FORBIDDEN_ZONE" } });
  });

  test("a traversal path (../../etc/passwd) is rejected 403 FORBIDDEN_ZONE", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();

    app = buildBridge(ctx, TOKEN);
    const res = await app.inject({
      method: "GET",
      url: `/provenance?path=${encodeURIComponent("../../etc/passwd")}`,
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "FORBIDDEN_ZONE" } });
  });

  test("a path that escapes the vault via a symlink is rejected 403 FORBIDDEN_ZONE", async () => {
    vault = await makeTestVault();
    const ctx = await openTestVault(vault);
    closeCtx = () => ctx.close();

    const outsideDir = mkdtempSync(join(tmpdir(), "vl-provenance-outside-"));
    writeFileSync(join(outsideDir, "secret.md"), "outside content\n", "utf8");
    mkdirSync(join(vault.vaultDir, "Agent"), { recursive: true });
    symlinkSync(outsideDir, join(vault.vaultDir, "Agent", "evil"));
    extraCleanup = () => rmSync(outsideDir, { recursive: true, force: true });

    app = buildBridge(ctx, TOKEN);
    const res = await app.inject({
      method: "GET",
      url: `/provenance?path=${encodeURIComponent("Agent/evil/secret.md")}`,
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "FORBIDDEN_ZONE" } });
  });
});
