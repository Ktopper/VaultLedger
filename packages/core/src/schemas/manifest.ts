import { z } from "zod";

export const Mode = z.enum(["safe", "assisted", "autonomous"]);
export const ZoneName = z.enum(["trusted", "agent", "scratch", "excluded"]);

export const PermissionsManifest = z.object({
  version: z.literal(1).default(1),
  mode: Mode.default("assisted"),
  zones: z
    .object({
      trusted: z.array(z.string()).default([]),
      agent: z.array(z.string()).default([]),
      scratch: z.array(z.string()).default([]),
      excluded: z.array(z.string()).default([]),
    })
    .default({}),
  overrides: z.array(z.object({ glob: z.string(), zone: ZoneName })).default([]),
});
export type PermissionsManifest = z.infer<typeof PermissionsManifest>;
export type ZoneName = z.infer<typeof ZoneName>;
