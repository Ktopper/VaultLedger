import picomatch from "picomatch";
import type { PermissionsManifest, ZoneName } from "./schemas/manifest.js";

function specificity(glob: string): number {
  return glob.split("/").filter((s) => s && s !== "**" && s !== "*").length;
}

export function resolveZone(path: string, m: PermissionsManifest): ZoneName {
  const norm = path.replace(/\\/g, "/").replace(/^(\.\/)+/, "");

  // Excluded always wins.
  if (m.zones.excluded.some((g) => picomatch(g, { dot: true })(norm))) return "excluded";

  // Tier 1: overrides. If any override matches, it wins over ALL base-zone
  // matches regardless of specificity. Specificity only breaks ties among
  // competing overrides.
  let bestOverride: { zone: ZoneName; score: number } | null = null;
  for (const o of m.overrides) {
    if (picomatch(o.glob, { dot: true })(norm)) {
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
      if (picomatch(g, { dot: true })(norm)) {
        const s = specificity(g);
        if (!bestBase || s > bestBase.score) bestBase = { zone, score: s };
      }
    }
  }

  return bestBase?.zone ?? "trusted";
}
