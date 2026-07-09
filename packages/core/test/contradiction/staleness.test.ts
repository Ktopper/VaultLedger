import { describe, expect, test } from "vitest";
import { staleSourceDetail } from "../../src/contradiction/staleness.js";
import { conflictValueHash } from "../../src/contradiction/valueHash.js";

describe("staleSourceDetail", () => {
  // Preimage lock: this test pins BOTH the exact template string and the
  // resulting conflictValueHash. If either assertion breaks, the format
  // changed -- that's a migration event (see staleness.ts's comment), not a
  // copyedit; do not "fix" this test by re-pinning the hash without reading
  // that comment first.
  test("golden string + pinned hash", () => {
    const detail = staleSourceDetail({
      distillationId: "mem_d",
      sourceId: "mem_s",
      sourceStatus: "retired",
      contentId: "sha256:abc",
    });

    expect(detail).toBe("stale-source: mem_d cites mem_s now retired (content sha256:abc)");
    expect(conflictValueHash(detail)).toBe(
      "sha256:b6683560b901b45bc9291cca5d101a3e3f141ecbca928197b603c4605fda81d8",
    );
  });

  test("GONE variant is deterministic across calls (same hash both times)", () => {
    const build = () =>
      staleSourceDetail({
        distillationId: "mem_d",
        sourceId: "mem_s",
        sourceStatus: "forgotten",
        contentId: "GONE",
      });

    const detailA = build();
    const detailB = build();

    expect(detailA).toBe(detailB);
    expect(detailA).toBe("stale-source: mem_d cites mem_s now forgotten (content GONE)");
    expect(conflictValueHash(detailA)).toBe(conflictValueHash(detailB));
  });
});
