import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrokerError, type ConflictRow, type EnrichedConflict, type MemoryRow } from "@vaultledger/core";
import { conflictsCommand } from "../src/commands/conflicts.js";
import { loadContext } from "../src/context.js";
import { makeInitializedVault, type TestVault } from "./helpers.js";

let vault: TestVault;

afterEach(() => {
  vault?.cleanup();
});

function memRow(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: "mem_a",
    path: "mem_a.md",
    entity: "nova",
    status: "canonical",
    confidence: "high",
    created: "2026-07-01T00:00:00.000Z",
    source: "chat",
    supersedes: null,
    expires: null,
    last_referenced: null,
    ...overrides,
  };
}

function conflictRow(overrides: Partial<ConflictRow> = {}): ConflictRow {
  return {
    id: "cf_1",
    memory_a: "mem_a",
    memory_b: "mem_b",
    pair_lo: "mem_a",
    pair_hi: "mem_b",
    kind: "value-conflict",
    fact_key: "deadline",
    value_hash: "sha256:vh_1",
    entity: "nova",
    detail: 'deadline: "2026-08-15" vs "2026-09-01"',
    created_at: "2026-07-01T00:00:01.000Z",
    state: "open",
    resolved_at: null,
    ...overrides,
  };
}

/** Seed one open conflict directly via the journal (mirrors core's own
 * conflicts/contradiction fixtures) — used by tests that only care about
 * list/resolve/dismiss, not real detection. */
async function seedConflict(vault: TestVault): Promise<void> {
  const ctx = await loadContext(vault.vaultDir, vault.deps);
  ctx.journal.insertMemory(memRow({ id: "mem_a", status: "canonical" }));
  ctx.journal.insertMemory(memRow({ id: "mem_b", path: "mem_b.md", status: "scratch" }));
  ctx.journal.insertConflict(conflictRow());
  ctx.db.close();
}

/** Write two real on-disk notes for the same entity with a contradicting
 * "deadline" fact (extracted from the body, no frontmatter needed — see
 * core's contradiction/extract.ts FACT_LINE_RE), and register both as
 * memories directly via the journal — enough for a real checkContradictions
 * run (driven by --rescan) to detect the conflict itself. */
async function seedContradictingMemories(vault: TestVault): Promise<void> {
  const dir = join(vault.vaultDir, "Agent", "Memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "mem_a.md"), "# Note A\n\ndeadline: 2026-08-15\n", "utf8");
  writeFileSync(join(dir, "mem_b.md"), "# Note B\n\ndeadline: 2026-09-01\n", "utf8");

  const ctx = await loadContext(vault.vaultDir, vault.deps);
  ctx.journal.insertMemory(
    memRow({ id: "mem_a", path: "Agent/Memory/mem_a.md", entity: "nova", status: "canonical" }),
  );
  ctx.journal.insertMemory(
    memRow({ id: "mem_b", path: "Agent/Memory/mem_b.md", entity: "nova", status: "scratch" }),
  );
  ctx.db.close();
}

describe("conflictsCommand", () => {
  test("default: lists 1 open conflict", async () => {
    vault = await makeInitializedVault();
    await seedConflict(vault);

    const messages: string[] = [];
    const result = await conflictsCommand(vault.vaultDir, { ...vault.deps, out: (s) => messages.push(s) });

    expect(result).toHaveLength(1);
    const [conflict] = result as EnrichedConflict[];
    expect(conflict!.row.id).toBe("cf_1");
    expect(conflict!.memoryA?.id).toBe("mem_a");
    expect(conflict!.memoryB?.id).toBe("mem_b");
    expect(messages.join("\n")).toContain("cf_1");
  });

  test("action resolve + id: closes it (list then empty)", async () => {
    vault = await makeInitializedVault();
    await seedConflict(vault);

    const messages: string[] = [];
    await conflictsCommand(vault.vaultDir, {
      ...vault.deps,
      action: "resolve",
      id: "cf_1",
      out: (s) => messages.push(s),
    });
    expect(messages.join("\n")).toContain("cf_1");

    const after = await conflictsCommand(vault.vaultDir, { ...vault.deps, out: () => {} });
    expect(after).toHaveLength(0);
  });

  test("action dismiss + id: closes it (list then empty)", async () => {
    vault = await makeInitializedVault();
    await seedConflict(vault);

    await conflictsCommand(vault.vaultDir, { ...vault.deps, action: "dismiss", id: "cf_1", out: () => {} });

    const after = await conflictsCommand(vault.vaultDir, { ...vault.deps, out: () => {} });
    expect(after).toHaveLength(0);
  });

  test("resolve on an unknown id errors (NOT_FOUND) instead of falsely claiming success", async () => {
    vault = await makeInitializedVault();

    const messages: string[] = [];
    await expect(
      conflictsCommand(vault.vaultDir, { ...vault.deps, action: "resolve", id: "cf_nope", out: (s) => messages.push(s) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Never printed a false "resolved cf_nope" confirmation.
    expect(messages.join("\n")).not.toContain("resolved cf_nope");
  });

  test("dismiss on an unknown id errors (NOT_FOUND) instead of falsely claiming success", async () => {
    vault = await makeInitializedVault();

    const messages: string[] = [];
    const err = await conflictsCommand(vault.vaultDir, {
      ...vault.deps,
      action: "dismiss",
      id: "cf_nope",
      out: (s) => messages.push(s),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BrokerError);
    expect((err as BrokerError).code).toBe("NOT_FOUND");
    expect(messages.join("\n")).not.toContain("dismissed cf_nope");
  });

  test("resolve on an already-dismissed conflict errors (ALREADY_CLOSED) instead of silently overwriting, and does not crash", async () => {
    vault = await makeInitializedVault();
    await seedConflict(vault);

    await conflictsCommand(vault.vaultDir, { ...vault.deps, action: "dismiss", id: "cf_1", out: () => {} });

    const messages: string[] = [];
    const err = await conflictsCommand(vault.vaultDir, {
      ...vault.deps,
      action: "resolve",
      id: "cf_1",
      out: (s) => messages.push(s),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BrokerError);
    expect((err as BrokerError).code).toBe("ALREADY_CLOSED");
    // Never printed a false "resolved cf_1" confirmation.
    expect(messages.join("\n")).not.toContain("resolved cf_1");

    // The stored state must still be 'dismissed' -- not flipped to 'resolved'.
    const ctx = await loadContext(vault.vaultDir, vault.deps);
    expect(ctx.journal.getConflict("cf_1")!.state).toBe("dismissed");
    ctx.db.close();
  });

  test("dismiss on an already-resolved conflict errors (ALREADY_CLOSED)", async () => {
    vault = await makeInitializedVault();
    await seedConflict(vault);

    await conflictsCommand(vault.vaultDir, { ...vault.deps, action: "resolve", id: "cf_1", out: () => {} });

    await expect(
      conflictsCommand(vault.vaultDir, { ...vault.deps, action: "dismiss", id: "cf_1", out: () => {} }),
    ).rejects.toMatchObject({ code: "ALREADY_CLOSED" });
  });

  test("--rescan re-detects a real contradiction, idempotently (still 1, not 2)", async () => {
    vault = await makeInitializedVault();
    await seedContradictingMemories(vault);

    const first = await conflictsCommand(vault.vaultDir, { ...vault.deps, rescan: true, out: () => {} });
    expect(first).toHaveLength(1);

    const second = await conflictsCommand(vault.vaultDir, { ...vault.deps, rescan: true, out: () => {} });
    expect(second).toHaveLength(1);
  });

  test("--rescan with --limit reaching the cap prints a warning instead of silently truncating", async () => {
    vault = await makeInitializedVault();
    const dir = join(vault.vaultDir, "Agent", "Memory");
    mkdirSync(dir, { recursive: true });
    // Three live memories, distinct entities (no contradictions needed --
    // only exercising the cap-detection path, not detection itself).
    writeFileSync(join(dir, "mem_a.md"), "# A\n\nnote: alpha\n", "utf8");
    writeFileSync(join(dir, "mem_b.md"), "# B\n\nnote: bravo\n", "utf8");
    writeFileSync(join(dir, "mem_c.md"), "# C\n\nnote: charlie\n", "utf8");
    const ctx = await loadContext(vault.vaultDir, vault.deps);
    ctx.journal.insertMemory(
      memRow({ id: "mem_a", path: "Agent/Memory/mem_a.md", entity: "alpha", status: "canonical" }),
    );
    ctx.journal.insertMemory(
      memRow({ id: "mem_b", path: "Agent/Memory/mem_b.md", entity: "bravo", status: "canonical" }),
    );
    ctx.journal.insertMemory(
      memRow({ id: "mem_c", path: "Agent/Memory/mem_c.md", entity: "charlie", status: "canonical" }),
    );
    ctx.db.close();

    const messages: string[] = [];
    await conflictsCommand(vault.vaultDir, {
      ...vault.deps,
      rescan: true,
      limit: 2,
      out: (s) => messages.push(s),
    });

    expect(messages.join("\n")).toMatch(/warning.*cap/i);
  });

  test("--rescan under the cap: no warning fires", async () => {
    vault = await makeInitializedVault();
    const dir = join(vault.vaultDir, "Agent", "Memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mem_a.md"), "# A\n\nnote: alpha\n", "utf8");
    writeFileSync(join(dir, "mem_b.md"), "# B\n\nnote: bravo\n", "utf8");
    const ctx = await loadContext(vault.vaultDir, vault.deps);
    ctx.journal.insertMemory(
      memRow({ id: "mem_a", path: "Agent/Memory/mem_a.md", entity: "alpha", status: "canonical" }),
    );
    ctx.journal.insertMemory(
      memRow({ id: "mem_b", path: "Agent/Memory/mem_b.md", entity: "bravo", status: "canonical" }),
    );
    ctx.db.close();

    const messages: string[] = [];
    await conflictsCommand(vault.vaultDir, {
      ...vault.deps,
      rescan: true,
      limit: 10,
      out: (s) => messages.push(s),
    });

    expect(messages.join("\n")).not.toMatch(/warning.*cap/i);
  });

  test("--rescan skips dead (forgotten) memories: no fresh conflict row for a forgotten peer", async () => {
    vault = await makeInitializedVault();
    // A forgotten memory that (were it live) would contradict a canonical peer
    // on `deadline`. rescan must NOT run detection off the dead memory, and the
    // canonical peer's own detection must skip the dead peer — so no open
    // conflict ever surfaces.
    const dir = join(vault.vaultDir, "Agent", "Memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mem_live.md"), "# Live\n\ndeadline: 2026-08-15\n", "utf8");
    writeFileSync(join(dir, "mem_dead.md"), "# Dead\n\ndeadline: 2026-09-01\n", "utf8");

    const ctx = await loadContext(vault.vaultDir, vault.deps);
    ctx.journal.insertMemory(
      memRow({ id: "mem_live", path: "Agent/Memory/mem_live.md", entity: "nova", status: "canonical" }),
    );
    ctx.journal.insertMemory(
      memRow({ id: "mem_dead", path: "Agent/Memory/mem_dead.md", entity: "nova", status: "forgotten" }),
    );
    ctx.db.close();

    const result = await conflictsCommand(vault.vaultDir, { ...vault.deps, rescan: true, out: () => {} });
    expect(result).toHaveLength(0);

    // And no conflict row was inserted at all (not merely filtered from the
    // open view) — the dead memory never seeded a zombie row.
    const after = await loadContext(vault.vaultDir, vault.deps);
    expect(after.journal.listConflicts()).toHaveLength(0);
    after.db.close();
  });
});
