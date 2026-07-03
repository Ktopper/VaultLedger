import { afterEach, describe, expect, test, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appSupportBase, readConfig } from "@vaultledger/core";
import { run } from "../src/index.js";
import { serveCommand, type ServeHandle } from "../src/commands/serve.js";
import { makeInitializedVault, type TestVault } from "./helpers.js";

let vault: TestVault | undefined;
let handle: ServeHandle | undefined;

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = undefined;
  }
  vault?.cleanup();
  vault = undefined;
});

/** A pid guaranteed to be dead: spawn a trivial child, let it exit, reuse
 * its (now-freed) pid. Barring immediate pid reuse (vanishingly unlikely in
 * a test window) `process.kill(deadPid, 0)` yields ESRCH. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  if (r.pid === undefined) throw new Error("could not spawn to obtain a dead pid");
  return r.pid;
}

function bridgePathFor(vault: TestVault): string {
  const config = readConfig(vault.vaultDir);
  return join(appSupportBase(vault.deps.env), config.vaultId, "bridge.json");
}

function writeBridgeJson(
  path: string,
  data: { port: number; token: string; pid: number; startedAt?: string },
  mode = 0o600,
): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ startedAt: "2020-01-01T00:00:00.000Z", ...data }, null, 2),
    { mode },
  );
  chmodSync(path, mode);
}

describe("serveCommand", () => {
  test(
    "starts the bridge, writes a 0600 bridge.json, serves an authenticated /status, close() tears everything down",
    async () => {
      vault = await makeInitializedVault();

      handle = await serveCommand(vault.vaultDir, {
        port: 0,
        env: vault.deps.env,
        now: () => "2026-01-01T00:00:00.000Z",
        mintToken: () => "tok_test_1",
        installSignalHandlers: false,
        out: () => {},
      });

      expect(handle.port).toBeGreaterThan(0);
      expect(handle.token).toBe("tok_test_1");

      const config = readConfig(vault.vaultDir);
      const expectedBridgePath = join(appSupportBase(vault.deps.env), config.vaultId, "bridge.json");
      expect(handle.bridgePath).toBe(expectedBridgePath);
      expect(existsSync(expectedBridgePath)).toBe(true);

      const raw = JSON.parse(readFileSync(expectedBridgePath, "utf8")) as Record<string, unknown>;
      expect(raw).toMatchObject({
        port: handle.port,
        token: "tok_test_1",
        pid: process.pid,
        startedAt: "2026-01-01T00:00:00.000Z",
      });

      const mode = statSync(expectedBridgePath).mode & 0o777;
      expect(mode).toBe(0o600);

      const res = await fetch(`http://127.0.0.1:${handle.port}/status`, {
        headers: { Authorization: "Bearer tok_test_1", Host: `127.0.0.1:${handle.port}` },
      });
      expect(res.status).toBe(200);

      const port = handle.port;
      await handle.close();
      handle = undefined;
      expect(existsSync(expectedBridgePath)).toBe(false);

      await expect(
        fetch(`http://127.0.0.1:${port}/status`, {
          headers: { Authorization: "Bearer tok_test_1" },
        }),
      ).rejects.toThrow();
    },
    20_000,
  );

  test("bridge.json is never written inside the vault", async () => {
    vault = await makeInitializedVault();

    handle = await serveCommand(vault.vaultDir, {
      port: 0,
      env: vault.deps.env,
      mintToken: () => "tok_test_2",
      installSignalHandlers: false,
      out: () => {},
    });

    expect(existsSync(join(vault.vaultDir, "bridge.json"))).toBe(false);
    const ledgerFiles = readdirSync(join(vault.vaultDir, ".ledger")).sort();
    expect(ledgerFiles).toEqual(["config.json", "permissions.yaml"]);
  });

  test(
    "--rotate-token mints a fresh token: the old token stops working, the new one works",
    async () => {
      vault = await makeInitializedVault();

      handle = await serveCommand(vault.vaultDir, {
        port: 0,
        env: vault.deps.env,
        mintToken: () => "old",
        installSignalHandlers: false,
        out: () => {},
      });
      await handle.close();
      handle = undefined;

      handle = await serveCommand(vault.vaultDir, {
        port: 0,
        env: vault.deps.env,
        rotateToken: true,
        mintToken: () => "new",
        installSignalHandlers: false,
        out: () => {},
      });

      const config = readConfig(vault.vaultDir);
      const bridgePath = join(appSupportBase(vault.deps.env), config.vaultId, "bridge.json");
      const raw = JSON.parse(readFileSync(bridgePath, "utf8")) as Record<string, unknown>;
      expect(raw.token).toBe("new");
      expect(raw.token).not.toBe("old");

      const oldRes = await fetch(`http://127.0.0.1:${handle.port}/status`, {
        headers: { Authorization: "Bearer old", Host: `127.0.0.1:${handle.port}` },
      });
      expect(oldRes.status).toBe(401);

      const newRes = await fetch(`http://127.0.0.1:${handle.port}/status`, {
        headers: { Authorization: "Bearer new", Host: `127.0.0.1:${handle.port}` },
      });
      expect(newRes.status).toBe(200);
    },
    20_000,
  );

  test("throws a friendly error on an uninitialized directory (no raw stack)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vl-uninit-"));
    try {
      await expect(serveCommand(dir, { installSignalHandlers: false })).rejects.toThrow(
        "not a VaultLedger vault (run `ledger init` first)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(
    "dead-pid bridge.json + no rotate: the previous session token is reused",
    async () => {
      vault = await makeInitializedVault();
      const bridgePath = bridgePathFor(vault);
      writeBridgeJson(bridgePath, { port: 12345, token: "reused_token", pid: deadPid() });

      handle = await serveCommand(vault.vaultDir, {
        port: 0,
        env: vault.deps.env,
        mintToken: () => "SHOULD_NOT_BE_USED",
        installSignalHandlers: false,
        out: () => {},
      });

      expect(handle.token).toBe("reused_token");
      const raw = JSON.parse(readFileSync(bridgePath, "utf8")) as Record<string, unknown>;
      expect(raw.token).toBe("reused_token");
      expect(raw.pid).toBe(process.pid);

      const res = await fetch(`http://127.0.0.1:${handle.port}/status`, {
        headers: { Authorization: "Bearer reused_token", Host: `127.0.0.1:${handle.port}` },
      });
      expect(res.status).toBe(200);
    },
    20_000,
  );

  test(
    "dead-pid bridge.json + --rotate-token: a fresh token is minted and the old one is revoked (401)",
    async () => {
      vault = await makeInitializedVault();
      const bridgePath = bridgePathFor(vault);
      writeBridgeJson(bridgePath, { port: 12345, token: "old", pid: deadPid() });

      handle = await serveCommand(vault.vaultDir, {
        port: 0,
        env: vault.deps.env,
        rotateToken: true,
        mintToken: () => "fresh",
        installSignalHandlers: false,
        out: () => {},
      });

      expect(handle.token).toBe("fresh");

      const oldRes = await fetch(`http://127.0.0.1:${handle.port}/status`, {
        headers: { Authorization: "Bearer old", Host: `127.0.0.1:${handle.port}` },
      });
      expect(oldRes.status).toBe(401);

      const newRes = await fetch(`http://127.0.0.1:${handle.port}/status`, {
        headers: { Authorization: "Bearer fresh", Host: `127.0.0.1:${handle.port}` },
      });
      expect(newRes.status).toBe(200);
    },
    20_000,
  );

  test("live-pid bridge.json: serveCommand refuses to start a second bridge", async () => {
    vault = await makeInitializedVault();
    const bridgePath = bridgePathFor(vault);
    // Our own pid is (by definition) alive.
    writeBridgeJson(bridgePath, { port: 55555, token: "incumbent", pid: process.pid });

    await expect(
      serveCommand(vault.vaultDir, {
        port: 0,
        env: vault.deps.env,
        mintToken: () => "wont-get-here",
        installSignalHandlers: false,
        out: () => {},
      }),
    ).rejects.toThrow(
      `a VaultLedger bridge is already running for this vault (pid ${process.pid}, port 55555)`,
    );

    // The incumbent's discovery file must NOT have been clobbered.
    const raw = JSON.parse(readFileSync(bridgePath, "utf8")) as Record<string, unknown>;
    expect(raw.token).toBe("incumbent");
    expect(raw.port).toBe(55555);
  });

  test(
    "a pre-existing world-readable (0644) bridge.json is replaced with a 0600 file",
    async () => {
      vault = await makeInitializedVault();
      const bridgePath = bridgePathFor(vault);
      writeBridgeJson(bridgePath, { port: 12345, token: "reused", pid: deadPid() }, 0o644);
      expect(statSync(bridgePath).mode & 0o777).toBe(0o644);

      handle = await serveCommand(vault.vaultDir, {
        port: 0,
        env: vault.deps.env,
        mintToken: () => "unused",
        installSignalHandlers: false,
        out: () => {},
      });

      expect(statSync(bridgePath).mode & 0o777).toBe(0o600);
    },
    20_000,
  );

  test(
    "close() only removes the discovery file if it still describes THIS instance",
    async () => {
      vault = await makeInitializedVault();
      const bridgePath = bridgePathFor(vault);

      handle = await serveCommand(vault.vaultDir, {
        port: 0,
        env: vault.deps.env,
        mintToken: () => "mine",
        installSignalHandlers: false,
        out: () => {},
      });

      // Simulate a NEWER bridge having taken over the discovery file (same
      // pid, different port -> not ours anymore).
      writeBridgeJson(bridgePath, { port: handle.port + 1, token: "newer", pid: process.pid });

      await handle.close();
      handle = undefined;

      expect(existsSync(bridgePath)).toBe(true);
      const raw = JSON.parse(readFileSync(bridgePath, "utf8")) as Record<string, unknown>;
      expect(raw.token).toBe("newer");
      rmSync(bridgePath, { force: true });
    },
    20_000,
  );

  test("commander --port validation accepts 0 (OS-assign sentinel) but rejects negatives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vl-uninit-"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Negative port: rejected by the validation BEFORE serveCommand runs.
      await run(["serve", dir, "--port", "-1"]);
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("invalid --port"))).toBe(true);

      errSpy.mockClear();

      // Port 0: passes validation (the documented OS-assign sentinel) and
      // reaches serveCommand, which fails only because `dir` is not a vault —
      // proving 0 is NOT rejected by the port check.
      await run(["serve", dir, "--port", "0"]);
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("invalid --port"))).toBe(false);
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("not a VaultLedger vault"))).toBe(true);
    } finally {
      errSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
