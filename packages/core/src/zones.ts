import picomatch from "picomatch";
import type { PermissionsManifest, ZoneName } from "./schemas/manifest.js";

function specificity(glob: string): number {
  return glob.split("/").filter((s) => s && s !== "**" && s !== "*").length;
}

export function resolveZone(path: string, m: PermissionsManifest): ZoneName {
  const norm = path.replace(/\\/g, "/").replace(/^\.\//, "");

  if (m.zones.excluded.some((g) => picomatch(g, { dot: true })(norm))) return "excluded";

  let best: { zone: ZoneName; score: number } | null = null;

  for (const o of m.overrides) {
    if (picomatch(o.glob, { dot: true })(norm)) {
      const s = specificity(o.glob) + 100;
      if (!best || s > best.score) best = { zone: o.zone, score: s };
    }
  }

  const order: ZoneName[] = ["scratch", "agent", "trusted"];
  for (const zone of order) {
    for (const g of m.zones[zone]) {
      if (picomatch(g, { dot: true })(norm)) {
        const s = specificity(g);
        if (!best || s > best.score) best = { zone, score: s };
      }
    }
  }

  return best?.zone ?? "trusted";
}
