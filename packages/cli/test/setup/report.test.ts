import { describe, expect, test } from "vitest";
import { renderReport } from "../../src/setup/report.js";
import type { StepResult } from "../../src/setup/types.js";

describe("renderReport", () => {
  test("fresh run: created/verified render as progress lines", () => {
    const results: StepResult[] = [
      { step: "init", state: "created", detail: "Initialized vault vault_abcd1234" },
      { step: "mcp", state: "created", detail: "wrote .mcp.json" },
      { step: "smoke", state: "verified", detail: "server responded pong in 42ms" },
    ];
    expect(renderReport(results)).toBe(
      [
        "✓ init created — Initialized vault vault_abcd1234",
        "✓ mcp created — wrote .mcp.json",
        "✓ smoke verified — server responded pong in 42ms",
      ].join("\n"),
    );
  });

  test("re-run: already/updated/outdated render diagnostic-shaped", () => {
    const results: StepResult[] = [
      { step: "init", state: "already", detail: "already initialized" },
      { step: "mcp", state: "already", detail: "entry present and matches" },
      { step: "smoke", state: "updated", detail: "config.json rewritten" },
      { step: "plugin", state: "outdated", detail: "0.3.0 → 0.4.0" },
    ];
    expect(renderReport(results)).toBe(
      [
        "· init already — already initialized ✓",
        "· mcp already — entry present and matches ✓",
        "· smoke updated — config.json rewritten ✓",
        "· plugin outdated (0.3.0 → 0.4.0) → rerun with --install-plugin",
      ].join("\n"),
    );
  });

  test("failed step renders as an error line", () => {
    const results: StepResult[] = [{ step: "smoke", state: "failed", detail: "server did not respond in 5000ms" }];
    expect(renderReport(results)).toBe("✗ smoke: server did not respond in 5000ms");
  });

  test("skipped step renders with its reason", () => {
    const results: StepResult[] = [{ step: "init", state: "skipped", detail: "aborted — nothing written" }];
    expect(renderReport(results)).toBe("· init skipped — aborted — nothing written");
  });

  test("empty results render as an empty string", () => {
    expect(renderReport([])).toBe("");
  });
});
