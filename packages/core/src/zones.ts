import picomatch from "picomatch";
import type { PermissionsManifest, ZoneName } from "./schemas/manifest.js";

// picomatch options shared by every match in this module. `nocase: true` is
// a deliberate hardening choice (fix 2): the security policy (this file) is
// evaluated on filesystems that can be case-insensitive/case-folding (APFS,
// NTFS), where "Private/x.md" and "private/x.md" name the same file. A
// case-sensitive glob would let an agent dodge an excluded/restricted glob
// purely by changing letter case. Matching case-insensitively means the
// MORE restrictive interpretation always wins, which is the safe direction
// here (excluded-always-wins; see below).
const PICOMATCH_OPTS = { dot: true, nocase: true } as const;

// Hard-coded, non-configurable always-excluded globs (fix 1). `.ledger/`
// holds the security policy itself (permissions.yaml) and the audit
// journal; `.git/` is the version-control internals; `.obsidian/` holds
// Obsidian's own config AND the review plugin's own data (including the
// bridge token). None may ever be exposed to the agent as anything other
// than "excluded", no matter what a (malicious or misconfigured) manifest
// configures — otherwise an agent could propose_edit its own permissions
// manifest (or read the plugin's bridge token) and a human approving what
// looks like an ordinary note edit could unknowingly widen zones, disable
// guards, or leak the token. This check runs BEFORE the manifest's own
// excluded globs and before overrides, and cannot be overridden by them.
const ALWAYS_EXCLUDED_GLOBS = [
  ".ledger", ".ledger/**",
  ".git", ".git/**",
  ".obsidian", ".obsidian/**",
];
const alwaysExcludedMatchers = ALWAYS_EXCLUDED_GLOBS.map((g) => picomatch(g, PICOMATCH_OPTS));

function specificity(glob: string): number {
  return glob.split("/").filter((s) => s && s !== "**" && s !== "*").length;
}

export function resolveZone(path: string, m: PermissionsManifest): ZoneName {
  const norm = path.replace(/\\/g, "/").replace(/^(\.\/)+/, "");

  // Hard-coded exclusion, checked before anything from the manifest
  // (defense in depth — see ALWAYS_EXCLUDED_GLOBS above).
  if (alwaysExcludedMatchers.some((match) => match(norm))) return "excluded";

  // Excluded always wins.
  if (m.zones.excluded.some((g) => picomatch(g, PICOMATCH_OPTS)(norm))) return "excluded";

  // Tier 1: overrides. If any override matches, it wins over ALL base-zone
  // matches regardless of specificity. Specificity only breaks ties among
  // competing overrides.
  let bestOverride: { zone: ZoneName; score: number } | null = null;
  for (const o of m.overrides) {
    if (picomatch(o.glob, PICOMATCH_OPTS)(norm)) {
      const s = specificity(o.glob);
      if (!bestOverride || s > bestOverride.score) bestOverride = { zone: o.zone, score: s };
    }
  }
  if (bestOverride) return bestOverride.zone;

  // Tier 2: base zones. Most-specific glob wins; scratch/agent/trusted order
  // breaks exact-specificity ties.
  const order: ZoneName[] = ["scratch", "agent", "trusted"];
  let bestBase: { zone: ZoneName; score: number } | null = null;
  for (const zone of order) {
    for (const g of m.zones[zone]) {
      if (picomatch(g, PICOMATCH_OPTS)(norm)) {
        const s = specificity(g);
        if (!bestBase || s > bestBase.score) bestBase = { zone, score: s };
      }
    }
  }

  return bestBase?.zone ?? "trusted";
}
