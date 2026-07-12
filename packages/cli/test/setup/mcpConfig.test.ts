import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildMcpConfig, mergeMcpConfig, resolveMcpServerEntry, writeMcpConfig } from "../../src/setup/mcpConfig.js";

describe("buildMcpConfig", () => {
  test("builds the exact vaultledger server entry", () => {
    expect(buildMcpConfig("/v", "/e")).toEqual({
      mcpServers: {
        vaultledger: { command: "node", args: ["/e", "--vault", "/v"] },
      },
    });
  });
});

describe("resolveMcpServerEntry", () => {
  test("resolves to an absolute built entry, or null if not built", () => {
    const entry = resolveMcpServerEntry();
    if (entry === null) {
      // mcp-server not built in this environment — acceptable negative case.
      expect(entry).toBeNull();
    } else {
      expect(entry.endsWith("mcp-server/dist/index.js")).toBe(true);
      expect(existsSync(entry)).toBe(true);
    }
  });
});

describe("mergeMcpConfig", () => {
  test("no existing config: creates fresh", () => {
    const result = mergeMcpConfig(null, "/v", "/e");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toBe("created");
    expect(JSON.parse(result.text)).toEqual({
      mcpServers: { vaultledger: { command: "node", args: ["/e", "--vault", "/v"] } },
    });
  });

  test("preserves sibling MCP servers (core data-loss guard)", () => {
    const existing = JSON.stringify({ mcpServers: { other: { command: "x" } } });
    const result = mergeMcpConfig(existing, "/v", "/e");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.text);
    expect(parsed.mcpServers.other).toEqual({ command: "x" });
    expect(parsed.mcpServers.vaultledger).toEqual({ command: "node", args: ["/e", "--vault", "/v"] });
  });

  test("preserves other top-level keys", () => {
    const existing = JSON.stringify({ someTopKey: 1, mcpServers: { other: { command: "x" } } });
    const result = mergeMcpConfig(existing, "/v", "/e");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.text);
    expect(parsed.someTopKey).toBe(1);
    expect(parsed.mcpServers.other).toEqual({ command: "x" });
    expect(parsed.mcpServers.vaultledger).toEqual({ command: "node", args: ["/e", "--vault", "/v"] });
  });

  test("existing vaultledger entry present: updated, overwritten, siblings intact", () => {
    const existing = JSON.stringify({
      mcpServers: {
        other: { command: "x" },
        vaultledger: { command: "node", args: ["/stale-entry", "--vault", "/stale-vault"] },
      },
    });
    const result = mergeMcpConfig(existing, "/v", "/e");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toBe("updated");
    const parsed = JSON.parse(result.text);
    expect(parsed.mcpServers.other).toEqual({ command: "x" });
    expect(parsed.mcpServers.vaultledger).toEqual({ command: "node", args: ["/e", "--vault", "/v"] });
  });

  test("unparseable existing text: fails without mutation", () => {
    const result = mergeMcpConfig("{ not json", "/v", "/e");
    expect(result).toEqual({ ok: false, reason: "unparseable" });
  });

  test("valid-JSON-but-not-an-object refuses rather than destroying the file", () => {
    // Each of these parses fine but is NOT a plain object. Merging into `{}`
    // would silently drop the payload; the caller trusting ok:true would then
    // writeMcpConfig over the real file. Refuse instead.
    const cases: string[] = [
      JSON.stringify([1, 2, 3]),
      "42",
      JSON.stringify("hello-sentinel"),
      "null",
    ];
    for (const existing of cases) {
      const result = mergeMcpConfig(existing, "/v", "/e");
      expect(result).toEqual({ ok: false, reason: "not-an-object" });
      // Belt-and-suspenders: no result text was produced at all.
      expect("text" in result).toBe(false);
    }
  });

  test("existing vaultledger extra fields (env, disabled) survive; command/args overwritten", () => {
    const existing = JSON.stringify({
      mcpServers: {
        vaultledger: {
          command: "node",
          args: ["/stale-entry", "--vault", "/stale-vault"],
          env: { SECRET: "1" },
          disabled: true,
        },
      },
    });
    const result = mergeMcpConfig(existing, "/v", "/e");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toBe("updated");
    const parsed = JSON.parse(result.text);
    expect(parsed.mcpServers.vaultledger).toEqual({
      command: "node",
      args: ["/e", "--vault", "/v"],
      env: { SECRET: "1" },
      disabled: true,
    });
  });

  test("mcpServers missing entirely: adds it, keeps other keys, state created", () => {
    const existing = JSON.stringify({ foo: 1 });
    const result = mergeMcpConfig(existing, "/v", "/e");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toBe("created");
    const parsed = JSON.parse(result.text);
    expect(parsed.foo).toBe(1);
    expect(parsed.mcpServers.vaultledger).toEqual({ command: "node", args: ["/e", "--vault", "/v"] });
  });

  test("re-merging an already-vaultledger config with the SAME entry: true no-op, state already", () => {
    const existing = JSON.stringify({
      mcpServers: {
        other: { command: "x" },
        vaultledger: { command: "node", args: ["/e", "--vault", "/v"] },
      },
    });
    const result = mergeMcpConfig(existing, "/v", "/e");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toBe("already");
    const parsed = JSON.parse(result.text);
    expect(parsed.mcpServers.other).toEqual({ command: "x" });
    expect(parsed.mcpServers.vaultledger).toEqual({ command: "node", args: ["/e", "--vault", "/v"] });
  });

  test("re-merging with a DIFFERENT entry (e.g. changed --vault path) still reports updated, not already", () => {
    const existing = JSON.stringify({
      mcpServers: { vaultledger: { command: "node", args: ["/e", "--vault", "/old-vault"] } },
    });
    const result = mergeMcpConfig(existing, "/v", "/e");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toBe("updated");
  });

  test("serialized text ends with a trailing newline", () => {
    const result = mergeMcpConfig(null, "/v", "/e");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.endsWith("\n")).toBe(true);
  });
});

describe("writeMcpConfig", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("writes into a nested non-existent directory, creating parents", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-mcp-config-"));
    const path = join(dir, "nested", "deeper", ".mcp.json");
    writeMcpConfig(path, '{"hello":"world"}\n');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe('{"hello":"world"}\n');
    expect(existsSync(path + ".tmp")).toBe(false);
  });

  test("overwrites an existing file, leaving no leftover .tmp file", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-mcp-config-"));
    const path = join(dir, ".mcp.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "old content", "utf8");
    writeMcpConfig(path, '{"fresh":true}\n');
    expect(readFileSync(path, "utf8")).toBe('{"fresh":true}\n');
    expect(existsSync(path + ".tmp")).toBe(false);
  });

  test("preserves restrictive file mode on overwrite (temp+rename must not loosen 0o600)", () => {
    dir = mkdtempSync(join(tmpdir(), "vl-mcp-config-"));
    const path = join(dir, ".mcp.json");
    mkdirSync(dir, { recursive: true });
    // A config holding sibling servers' env secrets may be chmod'd 600.
    writeFileSync(path, "old content", "utf8");
    chmodSync(path, 0o600);
    writeMcpConfig(path, '{"fresh":true}\n');
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(existsSync(path + ".tmp")).toBe(false);
  });
});
