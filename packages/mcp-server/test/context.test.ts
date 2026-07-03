import { afterEach, describe, expect, test, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadServerContext } from "../src/context.js";
import { makeTestVault, type TestVault } from "./helpers.js";

let vault: TestVault;

afterEach(() => {
  vault?.cleanup();
  vi.restoreAllMocks();
});

describe("loadServerContext startup sweep reporting", () => {
  test("a sweep with a failed forget writes a concise summary to stderr", async () => {
    vault = await makeTestVault();

    // Remember with a far-past clock so the scratch memory is well past the
    // default 14-day TTL by the time a later load runs its startup sweep.
    const oldNow = () => "2020-01-01T00:00:00.000Z";
    const first = await loadServerContext(vault.vaultDir, {
      ...vault.deps,
      now: oldNow,
      session: "s1",
    });
    const { path } = await first.store.remember({ content: "old", reason: "seed", session: "s1" });
    first.db.close();

    // Delete the memory file so the TTL sweep's forget throws (file missing on
    // disk) — that lands the memory id in the sweep's `failed` bucket.
    rmSync(join(vault.vaultDir, path), { force: true });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const now = () => "2026-07-03T00:00:00.000Z";
    const ctx = await loadServerContext(vault.vaultDir, { ...vault.deps, now, session: "s2" });
    try {
      expect(errorSpy).toHaveBeenCalled();
      const summary = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(summary).toMatch(/TTL sweep/i);
      expect(summary).toMatch(/failed 1/);
    } finally {
      ctx.db.close();
    }
  });

  test("a clean sweep (nothing archived/failed/malformed) writes nothing to stderr", async () => {
    vault = await makeTestVault();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = await loadServerContext(vault.vaultDir, { ...vault.deps, session: "s1" });
    try {
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      ctx.db.close();
    }
  });
});
