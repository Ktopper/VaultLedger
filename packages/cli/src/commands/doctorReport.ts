export type CheckStatus = "ok" | "warn" | "fail" | "skipped" | "info";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  remediation?: string;
}

const GLYPH: Record<CheckStatus, string> = {
  ok: "✓", info: "ℹ", skipped: "·", warn: "·", fail: "✗",
};

function line(c: CheckResult): string {
  const base = `${GLYPH[c.status]} ${c.name.padEnd(15)} ${c.status === "ok" ? "" : c.status} — ${c.detail}`;
  return c.remediation ? `${base} → ${c.remediation}` : base;
}

export function renderDoctorReport(checks: CheckResult[]): string {
  const counts = checks.reduce<Record<CheckStatus, number>>(
    (a, c) => ({ ...a, [c.status]: a[c.status] + 1 }),
    { ok: 0, info: 0, skipped: 0, warn: 0, fail: 0 },
  );
  const summary =
    `doctor: ${counts.ok} ok, ${counts.warn} warn, ${counts.fail} fail` +
    (counts.skipped ? `, ${counts.skipped} skipped` : "") +
    (counts.info ? `, ${counts.info} info` : "");
  return [...checks.map(line), summary].join("\n");
}
