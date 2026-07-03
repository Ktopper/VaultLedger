import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  mintVaultId,
  appSupportBase,
  journalPath,
  configPath,
  permissionsPath,
  readConfig,
  writeConfig,
  type LedgerConfig,
} from "../src/config.js";
import { BrokerError } from "../src/errors.js";

describe("config", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test("mintVaultId uses the injected rand function deterministically", () => {
    const id = mintVaultId(() => "deadbeef");
    expect(id).toBe("vault_deadbeef");
  });

  test("mintVaultId does not call Math.random (injected rand only)", () => {
    let calls = 0;
    const rand = () => {
      calls += 1;
      return "abc123";
    };
    const id = mintVaultId(rand);
    expect(calls).toBe(1);
    expect(id).toBe("vault_abc123");
  });

  test("appSupportBase resolves darwin path", () => {
    const base = appSupportBase({ HOME: "/Users/alice" }, "darwin");
    expect(base).toBe("/Users/alice/Library/Application Support/VaultLedger");
  });

  test("appSupportBase resolves win32 path from APPDATA", () => {
    const base = appSupportBase({ APPDATA: "C:\\Users\\alice\\AppData\\Roaming" }, "win32");
    expect(base).toBe(join("C:\\Users\\alice\\AppData\\Roaming", "VaultLedger"));
  });

  test("appSupportBase resolves linux path via XDG_DATA_HOME", () => {
    const base = appSupportBase({ XDG_DATA_HOME: "/home/alice/.local/share" }, "linux");
    expect(base).toBe("/home/alice/.local/share/VaultLedger");
  });

  test("appSupportBase falls back to HOME/.local/share on linux without XDG_DATA_HOME", () => {
    const base = appSupportBase({ HOME: "/home/alice" }, "linux");
    expect(base).toBe(join("/home/alice", ".local", "share", "VaultLedger"));
  });

  test("appSupportBase returns an ABSOLUTE path on darwin when HOME is unset", () => {
    const base = appSupportBase({}, "darwin");
    expect(isAbsolute(base)).toBe(true);
  });

  test("appSupportBase returns an ABSOLUTE path on win32 when APPDATA and HOME are unset", () => {
    const base = appSupportBase({}, "win32");
    expect(isAbsolute(base)).toBe(true);
  });

  test("appSupportBase returns an ABSOLUTE path on linux when XDG and HOME are unset", () => {
    const base = appSupportBase({}, "linux");
    expect(isAbsolute(base)).toBe(true);
  });

  test("journalPath composes appSupportBase + vaultId + journal.db", () => {
    const path = journalPath("vault_abc123", { HOME: "/Users/alice" }, "darwin");
    expect(path).toBe(
      join("/Users/alice/Library/Application Support/VaultLedger", "vault_abc123", "journal.db"),
    );
  });

  test("configPath and permissionsPath are under vaultRoot/.ledger", () => {
    expect(configPath("/vault")).toBe(join("/vault", ".ledger", "config.json"));
    expect(permissionsPath("/vault")).toBe(join("/vault", ".ledger", "permissions.yaml"));
  });

  test("writeConfig then readConfig round-trips", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-config-"));
    const cfg: LedgerConfig = {
      vaultId: "vault_xyz",
      ttlDays: 14,
      patchThreshold: 0.5,
      mode: "assisted",
      stalenessDays: 30,
    };
    writeConfig(dir, cfg);
    const read = readConfig(dir);
    expect(read).toEqual(cfg);
  });

  test("readConfig on a vault with no .ledger/config.json throws NOT_FOUND", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-config-"));
    let thrown: unknown;
    try {
      readConfig(dir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("NOT_FOUND");
  });

  test("readConfig on corrupted JSON throws a BrokerError, not a raw SyntaxError", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-config-"));
    mkdirSync(join(dir, ".ledger"), { recursive: true });
    writeFileSync(join(dir, ".ledger", "config.json"), "{ this is not valid json ", "utf8");

    let thrown: unknown;
    try {
      readConfig(dir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect(thrown).not.toBeInstanceOf(SyntaxError);
    expect((thrown as BrokerError).code).toBe("NOT_FOUND");
  });

  test("writeConfig does not leave a stray temp file behind (atomic rename)", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-config-"));
    const cfg: LedgerConfig = {
      vaultId: "vault_atomic",
      ttlDays: 14,
      patchThreshold: 0.5,
      mode: "assisted",
      stalenessDays: 30,
    };
    writeConfig(dir, cfg);
    const entries = readdirSync(join(dir, ".ledger"));
    expect(entries).toEqual(["config.json"]);
    expect(readConfig(dir)).toEqual(cfg);
  });

  test("journalPath rejects a vaultId containing path traversal", () => {
    let thrown: unknown;
    try {
      journalPath("../../etc", { HOME: "/Users/alice" }, "darwin");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
  });

  test("journalPath rejects a vaultId containing a slash", () => {
    let thrown: unknown;
    try {
      journalPath("vault/evil", { HOME: "/Users/alice" }, "darwin");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
  });

  test("journalPath accepts a well-formed vaultId", () => {
    const path = journalPath("vault_abc-123", { HOME: "/Users/alice" }, "darwin");
    expect(path).toContain("vault_abc-123");
  });
});
