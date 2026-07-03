import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appSupportBase, readConfig } from "@vaultledger/core";
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
});
