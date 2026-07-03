import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCommand } from "../src/commands/init.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vl-init-"));
  writeFileSync(join(dir, "note-one.md"), "# Note One\nsome content\n");
  mkdirSync(join(dir, "Agent"), { recursive: true });
  writeFileSync(join(dir, "Agent", "readme.md"), "agent note\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("initCommand", () => {
  test("dry run (confirm:false) writes nothing", async () => {
    const messages: string[] = [];
    const result = await initCommand(dir, { confirm: false, out: (s) => messages.push(s) });

    expect(existsSync(join(dir, ".ledger"))).toBe(false);
    expect(result.created).toBe(false);
    expect(result.profile.noteCount).toBeGreaterThan(0);
    expect(messages.length).toBeGreaterThan(0);
  });

  test("confirm:true creates .ledger config + permissions, inits git, leaves notes untouched", async () => {
    const before = {
      noteOne: readFileSync(join(dir, "note-one.md"), "utf8"),
      agentReadme: readFileSync(join(dir, "Agent", "readme.md"), "utf8"),
    };

    const result = await initCommand(dir, { confirm: true, rand: () => "abcd1234" });

    expect(result.created).toBe(true);
    expect(existsSync(join(dir, ".ledger", "config.json"))).toBe(true);
    expect(existsSync(join(dir, ".ledger", "permissions.yaml"))).toBe(true);
    expect(existsSync(join(dir, ".git"))).toBe(true);

    const config = JSON.parse(readFileSync(join(dir, ".ledger", "config.json"), "utf8"));
    expect(config.vaultId).toBe("vault_abcd1234");

    const after = {
      noteOne: readFileSync(join(dir, "note-one.md"), "utf8"),
      agentReadme: readFileSync(join(dir, "Agent", "readme.md"), "utf8"),
    };
    expect(after).toEqual(before);
  });

  test("second init is idempotent (does not re-mint vaultId)", async () => {
    await initCommand(dir, { confirm: true, rand: () => "abcd1234" });
    const configAfterFirst = readFileSync(join(dir, ".ledger", "config.json"), "utf8");

    const result = await initCommand(dir, { confirm: true, rand: () => "zzzzzzzz" });

    expect(result.created).toBe(false);
    const configAfterSecond = readFileSync(join(dir, ".ledger", "config.json"), "utf8");
    expect(configAfterSecond).toBe(configAfterFirst);
  });

  test("repairs a half-initialized vault: restores a missing permissions.yaml without re-minting", async () => {
    await initCommand(dir, { confirm: true, rand: () => "abcd1234" });
    const configBefore = readFileSync(join(dir, ".ledger", "config.json"), "utf8");

    // Simulate a crash between the two writes: permissions.yaml never landed.
    rmSync(join(dir, ".ledger", "permissions.yaml"), { force: true });
    expect(existsSync(join(dir, ".ledger", "permissions.yaml"))).toBe(false);

    const result = await initCommand(dir, { confirm: true, rand: () => "zzzzzzzz" });

    // Repaired, not a fresh create; config (and thus vaultId) is untouched.
    expect(result.created).toBe(false);
    expect(existsSync(join(dir, ".ledger", "permissions.yaml"))).toBe(true);
    const configAfter = readFileSync(join(dir, ".ledger", "config.json"), "utf8");
    expect(configAfter).toBe(configBefore);
    expect(JSON.parse(configAfter).vaultId).toBe("vault_abcd1234");
  });
});
