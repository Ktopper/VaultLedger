import { afterEach, describe, expect, test } from "vitest";
import { loadContext } from "../src/context.js";
import { auditCommand } from "../src/commands/audit.js";
import { makeInitializedVault, type TestVault } from "./helpers.js";

let vault: TestVault;

afterEach(() => {
  vault?.cleanup();
});

describe("auditCommand", () => {
  test("clean vault (nothing stale) prints zero stale distillations", async () => {
    vault = await makeInitializedVault();
    const ctx = await loadContext(vault.vaultDir, vault.deps);
    const s = await ctx.store.remember({
      content: "Alice prefers dark mode.",
      entity: "alice",
      reason: "seed",
      session: "s1",
    });
    await ctx.store.distill({
      content: "Alice's preferences summary.",
      sources: [s.id],
      reason: "summarize",
      session: "s1",
    });
    ctx.db.close();

    const messages: string[] = [];
    const result = await auditCommand(vault.vaultDir, vault.deps, {
      out: (s) => messages.push(s),
    });

    expect(result.staleFlagged).toBe(0);
    expect(result.pairs).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(messages).toContain("stale distillations: 0");
  });

  test("a vault with a dead-cited-source prints the stale pair", async () => {
    vault = await makeInitializedVault();
    const ctx = await loadContext(vault.vaultDir, vault.deps);

    const s = await ctx.store.remember({
      content: "Alice prefers dark mode.",
      entity: "alice",
      reason: "seed",
      session: "s1",
    });
    const d = await ctx.store.distill({
      content: "Alice's preferences summary.",
      sources: [s.id],
      reason: "summarize",
      session: "s1",
    });
    // Retire the source directly against the journal + a governed status
    // flip, mirroring core's store.setStatus — leaves the distillation's
    // citation stale without going through the event-driven retire path,
    // so this exercises the state-based scan.
    await ctx.store.setStatus(s.id, "retired", "superseded", "s1");

    ctx.db.close();

    const messages: string[] = [];
    const result = await auditCommand(vault.vaultDir, vault.deps, {
      out: (s) => messages.push(s),
    });

    expect(result.staleFlagged).toBe(1);
    expect(result.pairs).toEqual([{ distillation: d.id, source: s.id, reason: "retired" }]);
    expect(result.errors).toEqual([]);
    expect(messages).toContain("stale distillations: 1");
    expect(messages.some((m) => m.includes(`${d.id} cites ${s.id} (retired)`))).toBe(true);
  });
});
