import { afterEach, describe, expect, test } from "vitest";
import { loadServerContext, type ServerContext } from "../src/context.js";
import { buildTools } from "../src/tools.js";
import { makeTestVault, type TestVault } from "./helpers.js";

// VL-SEC-S7-04: ledger_status is agent-callable. It must not leak the
// excluded-zone glob patterns verbatim — that tells the agent exactly what
// (and, for a file-targeted override, precisely which file) is hidden from
// it. makeTestVault's manifest sets `excluded: ["Private/**"]`.

let vault: TestVault;
let ctx: ServerContext;

afterEach(() => {
  ctx?.db.close();
  vault?.cleanup();
});

describe("ledger_status excluded-zone redaction (VL-SEC-S7-04)", () => {
  test("result does not contain the excluded glob pattern verbatim", async () => {
    vault = await makeTestVault();
    ctx = await loadServerContext(vault.vaultDir, { ...vault.deps, session: "mcp-test-session" });
    // Sanity: the manifest genuinely carries the pattern this test guards.
    expect(ctx.manifest.zones.excluded).toContain("Private/**");

    const tools = new Map(buildTools(ctx).map((t) => [t.name, t]));
    const status = tools.get("ledger_status")!;
    const result = await status.handler({});

    expect(JSON.stringify(result)).not.toContain("Private/**");
    const zones = result.zones as Record<string, unknown>;
    expect(zones.excluded).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(zones, "excluded")).toBe(false);
    // Non-excluded zones are still reported.
    expect(zones.trusted).toEqual(ctx.manifest.zones.trusted);
    expect(zones.agent).toEqual(ctx.manifest.zones.agent);
    expect(zones.scratch).toEqual(ctx.manifest.zones.scratch);
  });
});
