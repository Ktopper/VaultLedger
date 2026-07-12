import type { StepResult, StepState } from "./types.js";

type Renderer = (r: StepResult) => string;

/** One renderer per StepState, table-driven so the mapping is exhaustive and
 * easy to audit at a glance. "Fresh" states (created/verified) render as
 * progress lines (`✓ …`); "re-run" states (already/updated/outdated) render
 * diagnostic-shaped (`· … ✓`, or a call-to-action for outdated); skipped and
 * failed each get their own explicit shape. */
const RENDERERS: Record<StepState, Renderer> = {
  created: (r) => `✓ ${r.step} created — ${r.detail}`,
  verified: (r) => `✓ ${r.step} verified — ${r.detail}`,
  // The ✓ sits on the STATUS portion (before the detail), not appended after
  // it — the plugin step's detail is multi-line (ends with the "Enable it:
  // …" instruction), so a trailing ✓ would land after "enable VaultLedger"
  // and misread as "enabling done" when it isn't.
  already: (r) => `· ${r.step} already ✓ — ${r.detail}`,
  updated: (r) => `· ${r.step} updated ✓ — ${r.detail}`,
  outdated: (r) => `· ${r.step} outdated (${r.detail}) → rerun with --install-plugin`,
  skipped: (r) => `· ${r.step} skipped — ${r.detail}`,
  failed: (r) => `✗ ${r.step}: ${r.detail}`,
};

/** Pure renderer: a sequence of StepResults -> a stable, human-readable
 * multi-line report. */
export function renderReport(results: StepResult[]): string {
  return results.map((r) => RENDERERS[r.state](r)).join("\n");
}
