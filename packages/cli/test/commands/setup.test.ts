import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setupCommand } from "../../src/commands/setup.js";
import type { SetupOptions, SetupSteps, StepResult } from "../../src/setup/types.js";
import { makeInitializedVault, type TestVault } from "../helpers.js";

function baseOpts(overrides: Partial<SetupOptions> = {}): SetupOptions {
  return { yes: false, installPlugin: false, json: false, ...overrides };
}

interface FakeSteps extends SetupSteps {
  calls: string[];
  smokeEnv?: NodeJS.ProcessEnv;
}

function makeFakeSteps(opts: {
  mcpResult?: StepResult;
  mcpEntry?: string | null;
  smokeResult?: StepResult;
  pluginResult?: StepResult;
} = {}): FakeSteps {
  const calls: string[] = [];
  const steps: FakeSteps = {
    calls,
    async configureMcp() {
      calls.push("configureMcp");
      return {
        result: opts.mcpResult ?? { step: "mcp", state: "created", detail: "wrote .mcp.json" },
        entry: opts.mcpEntry === undefined ? "node dist/index.js" : opts.mcpEntry,
      };
    },
    async smoke(_vault, _entry, env) {
      calls.push("smoke");
      steps.smokeEnv = env;
      return opts.smokeResult ?? { step: "smoke", state: "verified", detail: "server responded pong in 10ms" };
    },
    async installPlugin() {
      calls.push("installPlugin");
      return opts.pluginResult ?? { step: "plugin", state: "created", detail: "plugin installed" };
    },
  };
  return steps;
}

describe("setupCommand", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vl-setup-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("fresh vault + prompt 'n' -> init skipped, mcp/smoke never called, nothing written", async () => {
    const steps = makeFakeSteps();
    const messages: string[] = [];
    const results = await setupCommand(dir, baseOpts(), steps, {
      out: (s) => messages.push(s),
      promptInput: Readable.from(["n\n"]),
    });

    expect(results).toEqual([{ step: "init", state: "skipped", detail: "aborted — nothing written" }]);
    expect(steps.calls).toEqual([]);
    expect(existsSync(join(dir, ".ledger"))).toBe(false);
  });

  test("fresh vault + --yes -> init created, then configureMcp, then smoke, in order", async () => {
    const steps = makeFakeSteps();
    const messages: string[] = [];
    const results = await setupCommand(dir, baseOpts({ yes: true }), steps, {
      out: (s) => messages.push(s),
    });

    expect(results[0]).toMatchObject({ step: "init", state: "created" });
    expect(results[1]).toMatchObject({ step: "mcp", state: "created" });
    expect(results[2]).toMatchObject({ step: "smoke", state: "verified" });
    expect(steps.calls).toEqual(["configureMcp", "smoke"]);
    expect(existsSync(join(dir, ".ledger", "config.json"))).toBe(true);
  });

  test("installPlugin:false -> installPlugin never called", async () => {
    const steps = makeFakeSteps();
    const results = await setupCommand(dir, baseOpts({ yes: true, installPlugin: false }), steps, {
      out: () => {},
    });

    expect(steps.calls).not.toContain("installPlugin");
    expect(results.some((r) => r.step === "plugin")).toBe(false);
  });

  test("installPlugin:true -> installPlugin called after smoke", async () => {
    const steps = makeFakeSteps();
    const results = await setupCommand(dir, baseOpts({ yes: true, installPlugin: true }), steps, {
      out: () => {},
    });

    expect(steps.calls).toEqual(["configureMcp", "smoke", "installPlugin"]);
    expect(results[3]).toMatchObject({ step: "plugin", state: "created" });
  });

  test("--json -> out receives parseable StepResult[]", async () => {
    const steps = makeFakeSteps();
    const messages: string[] = [];
    const results = await setupCommand(dir, baseOpts({ yes: true, json: true }), steps, {
      out: (s) => messages.push(s),
    });

    expect(messages.length).toBeGreaterThan(0);
    const lastMessage = messages[messages.length - 1];
    expect(lastMessage).toBeDefined();
    const parsed = JSON.parse(lastMessage as string) as StepResult[];
    expect(parsed).toEqual(results);
  });

  test("mcp step failure stops before smoke", async () => {
    const steps = makeFakeSteps({
      mcpResult: { step: "mcp", state: "failed", detail: "could not write mcp.json" },
      mcpEntry: null,
    });
    const results = await setupCommand(dir, baseOpts({ yes: true }), steps, { out: () => {} });

    expect(results[0]).toMatchObject({ step: "init", state: "created" });
    expect(results[1]).toMatchObject({ step: "mcp", state: "failed" });
    expect(results).toHaveLength(2);
    expect(steps.calls).toEqual(["configureMcp"]);
  });

  test("smoke receives process.env when deps.env is omitted", async () => {
    const steps = makeFakeSteps();
    await setupCommand(dir, baseOpts({ yes: true }), steps, { out: () => {} });

    expect(steps.smokeEnv).toBe(process.env);
  });

  test("smoke receives exactly deps.env when provided", async () => {
    const steps = makeFakeSteps();
    const injectedEnv = { HOME: "/tmp/fake-home", PATH: "/usr/bin" } as NodeJS.ProcessEnv;
    await setupCommand(dir, baseOpts({ yes: true }), steps, { out: () => {}, env: injectedEnv });

    expect(steps.smokeEnv).toBe(injectedEnv);
  });

  describe("already-initialized vault", () => {
    let vault: TestVault;

    beforeEach(async () => {
      vault = await makeInitializedVault();
    });

    afterEach(() => {
      vault.cleanup();
    });

    test("init step reports already, no prompt consumed, proceeds to mcp/smoke", async () => {
      const steps = makeFakeSteps();
      // No input at all fed to the prompt — if setupCommand tried to prompt,
      // promptYesNo would hit EOF and resolve false, which would short-circuit
      // before mcp/smoke ever ran. Asserting they DID run proves no prompt fired.
      const results = await setupCommand(vault.vaultDir, baseOpts(), steps, {
        out: () => {},
        promptInput: Readable.from([]),
      });

      expect(results[0]).toEqual({ step: "init", state: "already", detail: "already initialized" });
      expect(steps.calls).toEqual(["configureMcp", "smoke"]);
    });
  });
});
