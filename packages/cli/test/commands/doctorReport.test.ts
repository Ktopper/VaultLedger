import { describe, expect, test } from "vitest";
import { renderDoctorReport, type CheckResult } from "../../src/commands/doctorReport.js";

const CHECKS: CheckResult[] = [
  { name: "config", status: "ok", detail: "valid (vault_ab12)" },
  { name: "journal", status: "warn", detail: "not built yet", remediation: "run `ledger reindex`" },
  { name: "mcp", status: "fail", detail: "not resolvable", remediation: "reinstall @vaultledger/cli" },
  { name: "permissions", status: "skipped", detail: "no initialized vault" },
  { name: "versions", status: "info", detail: "cli 0.4.0, mcp 0.4.0" },
];

describe("renderDoctorReport", () => {
  test("renders one line per check with a status glyph and a summary", () => {
    const out = renderDoctorReport(CHECKS);
    expect(out).toContain("config");
    expect(out).toContain("✗");            // fail glyph present
    expect(out).toMatch(/run `ledger reindex`/); // remediation shown for warn
    expect(out).toMatch(/1 ok.*1 warn.*1 fail/s); // summary counts
  });
});
