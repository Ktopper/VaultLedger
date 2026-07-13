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

/** `zones` shape safe to hand to an agent: the excluded-zone glob patterns
 * (and, by construction, anything derived only from them) are omitted. */
export interface AgentVisibleZones {
  trusted: string[];
  agent: string[];
  scratch: string[];
}

/**
 * Redact `zones.excluded` before returning zone info to an agent-facing
 * surface (the MCP `ledger_status` tool, the bridge's `GET /status` route).
 * The excluded globs name exactly what is hidden from the agent — including
 * an override that targets a specific file/folder — so returning them
 * verbatim is itself an existence/path disclosure to the agent (VL-SEC-S7-04).
 *
 * The human-facing CLI `status` command deliberately does NOT use this: a
 * human running `ledger status` locally configured the exclusions and is
 * entitled to see what they set up.
 */
export function redactExcludedZones(zones: PermissionsManifest["zones"]): AgentVisibleZones {
  return { trusted: zones.trusted, agent: zones.agent, scratch: zones.scratch };
}
