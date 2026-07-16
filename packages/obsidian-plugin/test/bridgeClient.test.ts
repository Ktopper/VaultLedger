import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatch } from "diff";
import {
  DEFAULT_LEDGER_CONFIG,
  LedgerGit,
  hashFile,
  mintVaultId,
  openVault,
  permissionsPath,
  readConfig,
  vaultLockDir,
  writeConfig,
} from "@vault-ledger/core";
import { startBridge, type RunningBridge } from "@vault-ledger/server";
import { BridgeClient, BridgeUnavailableError } from "../src/bridgeClient.js";

const RAW_MANIFEST = `version: 1
mode: assisted
zones:
  trusted:
    - "**"
  agent:
    - "Agent/**"
  scratch:
    - "Agent/Scratch/**"
  excluded:
    - "Private/**"
overrides: []
`;

function makeClock(): { now: () => string; genId: (prefix: string) => string } {
  let tick = 0;
  let counter = 0;
  return {
    now: () => {
      tick += 1;
      return new Date(2026, 0, 1, 0, 0, tick).toISOString();
    },
    genId: (prefix: string) => {
      counter += 1;
      return `${prefix}_${counter}`;
    },
  };
}

interface TestVault {
  vaultDir: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

/** A minimal but real VaultLedger vault on disk + a temp HOME, mirroring
 * packages/server/test/helpers.ts's makeTestVault — reimplemented locally so
 * the plugin package doesn't reach into another package's test-only files. */
async function makeTestVault(rand: () => string = () => "test1234"): Promise<TestVault> {
  const vaultDir = mkdtempSync(join(tmpdir(), "vl-plugin-vault-"));
  const homeDir = mkdtempSync(join(tmpdir(), "vl-plugin-home-"));

  mkdirSync(join(vaultDir, "Notes"), { recursive: true });
  writeFileSync(join(vaultDir, "Notes", "trusted.md"), "# Trusted note\n\nSome content.\n", "utf8");

  const git = new LedgerGit(vaultDir);
  await git.init();

  mkdirSync(join(vaultDir, ".ledger"), { recursive: true });
  writeFileSync(permissionsPath(vaultDir), RAW_MANIFEST, "utf8");
  writeConfig(vaultDir, { ...DEFAULT_LEDGER_CONFIG, vaultId: mintVaultId(rand) });

  const env = { HOME: homeDir } as NodeJS.ProcessEnv;
  return {
    vaultDir,
    homeDir,
    env,
    cleanup: () => {
      rmSync(vaultDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

const TOKEN = "test-token-abc123";

/** The core-computed on-disk path `ledger serve` publishes bridge.json to and
 * `fromVault` re-reads on every (re)discovery. */
function bridgeJsonPathFor(vaultDir: string, env: NodeJS.ProcessEnv): string {
  const { vaultId } = readConfig(vaultDir);
  return join(vaultLockDir(vaultId, env), "bridge.json");
}

/** Atomically (write-tmp + rename) publish a bridge.json at the same path
 * `ledger serve` uses — the discovery substrate reconnect re-reads. */
function writeBridgeJson(
  vaultDir: string,
  env: NodeJS.ProcessEnv,
  port: number,
  token: string,
  now: () => string,
): void {
  const bridgeJsonPath = bridgeJsonPathFor(vaultDir, env);
  mkdirSync(join(bridgeJsonPath, ".."), { recursive: true });
  const tmpPath = `${bridgeJsonPath}.tmp`;
  writeFileSync(
    tmpPath,
    JSON.stringify({ port, token, pid: process.pid, startedAt: now() }),
    "utf8",
  );
  renameSync(tmpPath, bridgeJsonPath);
}

let vault: TestVault | undefined;
let bridge: RunningBridge | undefined;

afterEach(async () => {
  if (bridge) {
    await bridge.close();
    bridge = undefined;
  }
  if (vault) {
    vault.cleanup();
    vault = undefined;
  }
});

describe("BridgeClient", () => {
  test("status() and memories() return typed data from a live bridge", async () => {
    vault = await makeTestVault();
    const clock = makeClock();
    bridge = await startBridge(vault.vaultDir, { token: TOKEN, now: clock.now, genId: clock.genId, env: vault.env });

    const client = new BridgeClient(`http://127.0.0.1:${bridge.port}`, TOKEN);

    const status = await client.status();
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("expected ok status");
    expect(status.data.mode).toBe("assisted");
    expect(status.data.pendingApprovals).toBe(0);

    // Seed a memory via a second openVault+store write against the same
    // vault (there is no `remember` route on the bridge itself).
    const seedCtx = await openVault(vault.vaultDir, {
      now: clock.now,
      genId: clock.genId,
      env: vault.env,
      session: "seed-session",
    });
    try {
      await seedCtx.store.remember({ content: "# a remembered fact\n", reason: "seed", session: "seed-session" });
    } finally {
      seedCtx.close();
    }

    const memories = await client.memories();
    expect(memories.ok).toBe(true);
    if (!memories.ok) throw new Error("expected ok memories");
    expect(memories.data.length).toBeGreaterThanOrEqual(1);
  });

  test("approve/reject/undo against real queued items return typed results; unknown id is a typed NOT_FOUND, not a throw", async () => {
    vault = await makeTestVault();
    const clock = makeClock();
    bridge = await startBridge(vault.vaultDir, { token: TOKEN, now: clock.now, genId: clock.genId, env: vault.env });

    // Seed a queued propose_edit via a second openVault over the same vault
    // (same pattern as the memories seed above) so the bridge's own ctx picks
    // it up from the shared on-disk journal.
    const seedCtx = await openVault(vault.vaultDir, {
      now: clock.now,
      genId: clock.genId,
      env: vault.env,
      session: "s1",
    });
    let approvalId: string;
    try {
      const abs = join(vault.vaultDir, "Notes", "trusted.md");
      // Padded well beyond a single line so a one-word substitution stays
      // comfortably under the broker's PATCH_TOO_LARGE changed-ratio guard
      // (a tiny file trips it on even a small edit — same padding
      // packages/server/test/mutations.test.ts uses for the same reason).
      const before =
        "# Trusted note\n\n" +
        "Filler line 1.\nFiller line 2.\nFiller line 3.\nFiller line 4.\nFiller line 5.\n" +
        "Some content.\n";
      writeFileSync(abs, before, "utf8");
      const after = before.replace("Some content.", "Some DIFFERENT content.");
      const patch = createPatch("trusted.md", before, after);
      const queued = await seedCtx.broker.apply({
        op: "propose_edit",
        path: "Notes/trusted.md",
        expected_hash: hashFile(abs),
        patch,
        reason: "test propose",
        session: "s1",
      });
      if (!("queued" in queued) || !queued.queued) throw new Error("expected queued");
      approvalId = queued.approvalId;
    } finally {
      seedCtx.close();
    }

    const client = new BridgeClient(`http://127.0.0.1:${bridge.port}`, TOKEN);

    const approveResult = await client.approve(approvalId);
    expect(approveResult).toEqual({ ok: true, data: { applied: true } });

    const rejectUnknown = await client.reject("apr_does_not_exist");
    expect(rejectUnknown.ok).toBe(false);
    if (rejectUnknown.ok) throw new Error("expected a rejection");
    expect(rejectUnknown.error.code).toBe("NOT_FOUND");
    expect(rejectUnknown.status).toBe(404);

    const approveUnknown = await client.approve("apr_does_not_exist");
    expect(approveUnknown).toEqual({
      ok: false,
      status: 404,
      error: expect.objectContaining({ code: "NOT_FOUND" }),
    });

    const txns = await client.transactions();
    expect(txns.ok).toBe(true);
    if (!txns.ok) throw new Error("expected ok transactions");
    const txnId = txns.data[0]?.id;
    expect(typeof txnId).toBe("string");

    const undoResult = await client.undo(txnId as string);
    expect(undoResult.ok).toBe(true);
    if (!undoResult.ok) throw new Error("expected ok undo");
    expect(undoResult.data).toMatchObject({ revertSha: expect.any(String), revertTxnId: expect.any(String) });

    const undoUnknown = await client.undo("txn_does_not_exist");
    expect(undoUnknown.ok).toBe(false);
    if (undoUnknown.ok) throw new Error("expected undo failure");
    expect(undoUnknown.error.code).toBe("NOT_FOUND");
    expect(undoUnknown.status).toBe(404);
  });

  test("conflicts()/resolveConflict()/dismissConflict() hit the bridge and return typed results", async () => {
    vault = await makeTestVault();
    const clock = makeClock();
    bridge = await startBridge(vault.vaultDir, { token: TOKEN, now: clock.now, genId: clock.genId, env: vault.env });

    // Seed one open conflict directly via the journal (no dedicated "create a
    // contradiction" route exists on the bridge) — same direct-insert
    // approach packages/server/test/conflicts.test.ts uses.
    const seedCtx = await openVault(vault.vaultDir, {
      now: clock.now,
      genId: clock.genId,
      env: vault.env,
      session: "seed-session",
    });
    try {
      seedCtx.journal.insertMemory({
        id: "mem_a",
        path: "Notes/trusted.md",
        entity: "nova",
        status: "canonical",
        confidence: "high",
        created: clock.now(),
        source: "chat",
        supersedes: null,
        expires: null,
        last_referenced: null,
      });
      seedCtx.journal.insertMemory({
        id: "mem_b",
        path: "Notes/trusted.md",
        entity: "nova",
        status: "scratch",
        confidence: "high",
        created: clock.now(),
        source: "chat",
        supersedes: null,
        expires: null,
        last_referenced: null,
      });
      seedCtx.journal.insertConflict({
        id: "cf_1",
        memory_a: "mem_a",
        memory_b: "mem_b",
        pair_lo: "mem_a",
        pair_hi: "mem_b",
        kind: "value-conflict",
        fact_key: "deadline",
        value_hash: "sha256:vh_1",
        entity: "nova",
        detail: 'deadline: "2026-08-15" vs "2026-09-01"',
        created_at: clock.now(),
        state: "open",
        resolved_at: null,
      });
    } finally {
      seedCtx.close();
    }

    const client = new BridgeClient(`http://127.0.0.1:${bridge.port}`, TOKEN);

    const list = await client.conflicts();
    expect(list.ok).toBe(true);
    if (!list.ok) throw new Error("expected ok conflicts");
    expect(list.data).toHaveLength(1);
    expect(list.data[0]?.row.id).toBe("cf_1");
    expect(list.data[0]?.memoryA?.id).toBe("mem_a");
    expect(list.data[0]?.memoryB?.id).toBe("mem_b");

    const resolveResult = await client.resolveConflict("cf_1");
    expect(resolveResult).toEqual({ ok: true, data: { resolved: true } });

    const afterResolve = await client.conflicts();
    if (!afterResolve.ok) throw new Error("expected ok conflicts");
    expect(afterResolve.data).toHaveLength(0);

    const dismissUnknown = await client.dismissConflict("cf_does_not_exist");
    expect(dismissUnknown.ok).toBe(false);
    if (dismissUnknown.ok) throw new Error("expected a rejection");
    expect(dismissUnknown.error.code).toBe("NOT_FOUND");
    expect(dismissUnknown.status).toBe(404);
  });

  test("fromVault reads vaultId + bridge.json and connects; missing bridge.json throws BridgeUnavailableError", async () => {
    vault = await makeTestVault();
    const clock = makeClock();

    // Missing bridge.json first.
    await expect(BridgeClient.fromVault(vault.vaultDir, { env: vault.env })).rejects.toBeInstanceOf(
      BridgeUnavailableError,
    );

    bridge = await startBridge(vault.vaultDir, { token: TOKEN, now: clock.now, genId: clock.genId, env: vault.env });

    // Write bridge.json at the SAME core-computed path the plugin's
    // discovery logic must compute independently.
    const { vaultId } = readConfig(vault.vaultDir);
    const appDir = vaultLockDir(vaultId, vault.env);
    mkdirSync(appDir, { recursive: true });
    const bridgeJsonPath = join(appDir, "bridge.json");
    const tmpPath = `${bridgeJsonPath}.tmp`;
    writeFileSync(
      tmpPath,
      JSON.stringify({ port: bridge.port, token: TOKEN, pid: process.pid, startedAt: clock.now() }),
      "utf8",
    );
    renameSync(tmpPath, bridgeJsonPath);

    const client = await BridgeClient.fromVault(vault.vaultDir, { env: vault.env });
    const status = await client.status();
    expect(status.ok).toBe(true);
  });

  test("wrong token surfaces a 401 as a typed auth error, not a hang", async () => {
    vault = await makeTestVault();
    const clock = makeClock();
    bridge = await startBridge(vault.vaultDir, { token: TOKEN, now: clock.now, genId: clock.genId, env: vault.env });

    const client = new BridgeClient(`http://127.0.0.1:${bridge.port}`, "wrong-token");
    const status = await client.status();
    expect(status.ok).toBe(false);
    if (status.ok) throw new Error("expected auth failure");
    expect(status.status).toBe(401);
    expect(status.error.code).toBe("UNAUTHORIZED");
  });

  test("network failure (bridge down) throws BridgeUnavailableError", async () => {
    const client = new BridgeClient("http://127.0.0.1:1", TOKEN);
    await expect(client.status()).rejects.toBeInstanceOf(BridgeUnavailableError);
  });

  test("a wedged bridge (accepts the socket but never replies) times out as BridgeUnavailableError within bound, not a hang", async () => {
    // A bare TCP server that accepts connections but NEVER writes a response
    // — the exact "process alive but wedged" shape `fetch` alone would hang
    // on forever (no immediate network failure to reject with). Track the
    // accepted sockets so teardown can force-destroy them: server.close()
    // only *waits* for open connections, and this one is deliberately never
    // closed by the peer, so it would otherwise hang the test's own cleanup.
    const sockets: Socket[] = [];
    const server: Server = createServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      // A short injected timeout keeps the test fast + deterministic.
      const client = new BridgeClient(`http://127.0.0.1:${port}`, TOKEN, { timeoutMs: 200 });
      const start = Date.now();
      await expect(client.status()).rejects.toBeInstanceOf(BridgeUnavailableError);
      // Comfortably under the default 5s: proves the timeout fired, not a hang.
      expect(Date.now() - start).toBeLessThan(2000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("an injected fetch that rejects with an AbortError maps to BridgeUnavailableError", async () => {
    const abortingFetch: typeof fetch = () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    };
    const client = new BridgeClient("http://127.0.0.1:9", TOKEN, { fetch: abortingFetch });
    await expect(client.status()).rejects.toBeInstanceOf(BridgeUnavailableError);
  });

  test("reconnects: a request failing on port A re-discovers bridge.json (port B + rotated token) and succeeds on B", async () => {
    vault = await makeTestVault();
    const clock = makeClock();
    const ROTATED = "rotated-token-xyz";
    // The REAL bridge that will be discovered on retry runs with a ROTATED
    // token — the exact `ledger serve --rotate-token` / bridge-restart shape.
    bridge = await startBridge(vault.vaultDir, {
      token: ROTATED,
      now: clock.now,
      genId: clock.genId,
      env: vault.env,
    });

    // bridge.json initially points to a DEAD port A with the OLD token, so the
    // client fromVault builds against A.
    writeBridgeJson(vault.vaultDir, vault.env, 1, TOKEN, clock.now);
    const client = await BridgeClient.fromVault(vault.vaultDir, { env: vault.env });

    // Bridge "restarts" on port B with the rotated token: rewrite bridge.json.
    writeBridgeJson(vault.vaultDir, vault.env, bridge.port, ROTATED, clock.now);

    // First attempt hits dead port A → reconnect re-reads bridge.json → retries
    // on B WITH the rotated token. A wrong token would come back as a typed 401
    // (ok:false), so ok:true proves the rotated token was picked up.
    const status = await client.status();
    expect(status.ok).toBe(true);
  });

  test("reconnects: request fails and bridge.json is gone → BridgeUnavailableError", async () => {
    vault = await makeTestVault();
    const clock = makeClock();

    writeBridgeJson(vault.vaultDir, vault.env, 1, TOKEN, clock.now);
    const client = await BridgeClient.fromVault(vault.vaultDir, { env: vault.env });

    // Bridge gone entirely: remove the discovery file. First attempt fails on
    // dead port A → re-discovery finds no bridge.json → BridgeUnavailableError.
    rmSync(bridgeJsonPathFor(vault.vaultDir, vault.env), { force: true });
    await expect(client.status()).rejects.toBeInstanceOf(BridgeUnavailableError);
  });

  test("reconnects: retry against port B also fails → BridgeUnavailableError with exactly two attempts (no recursion)", async () => {
    vault = await makeTestVault();
    const clock = makeClock();

    let calls = 0;
    const countingFetch: typeof fetch = () => {
      calls += 1;
      return Promise.reject(new Error("ECONNREFUSED"));
    };

    writeBridgeJson(vault.vaultDir, vault.env, 1, TOKEN, clock.now);
    const client = await BridgeClient.fromVault(vault.vaultDir, {
      env: vault.env,
      fetch: countingFetch,
    });

    // Re-discovery finds a DIFFERENT (still dead) port B; the single retry
    // against it also fails. Exactly two #doRequest attempts — no recursion.
    writeBridgeJson(vault.vaultDir, vault.env, 2, TOKEN, clock.now);
    await expect(client.status()).rejects.toBeInstanceOf(BridgeUnavailableError);
    expect(calls).toBe(2);
  });
});
