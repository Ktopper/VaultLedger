import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Broker } from "../../src/broker/broker.js";
import { UNSAFE_NO_LOCK } from "../../src/concurrency/lock.js";
import { LedgerGit } from "../../src/broker/git.js";
import { Journal } from "../../src/journal/journal.js";
import { openJournal } from "../../src/journal/db.js";
import { MemoryStore } from "../../src/memory/store.js";
import { sweep, findStale } from "../../src/memory/ttl.js";
import type { PermissionsManifest } from "../../src/schemas/manifest.js";
import type { MemoryRow } from "../../src/journal/journal.js";

const MANIFEST: PermissionsManifest = {
  version: 1,
  mode: "assisted",
  zones: {
    agent: ["Agent/**"],
    scratch: ["Agent/Scratch/**"],
    excluded: ["Private/**"],
    trusted: ["**"],
  },
  overrides: [],
};

const MS_PER_DAY = 86400000;
const FIXED_NOW_MS = Date.parse("2026-02-15T00:00:00.000Z");
const fixedNow = (): string => new Date(FIXED_NOW_MS).toISOString();
function daysAgo(n: number): string {
  return new Date(FIXED_NOW_MS - n * MS_PER_DAY).toISOString();
}

function makeClock(): { now: () => string; genId: (prefix: string) => string } {
  let tick = 0;
  let counter = 0;
  return {
    now: () => {
      tick += 1;
      return new Date(2026, 0, 1, 0, 0, tick).toISOString();
    },
    genId: (prefix: string) => {
      counter += 1;
      return `${prefix}_${counter}`;
    },
  };
}

describe("ttl sweep", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  async function makeHarness(): Promise<{
    store: MemoryStore;
    journal: Journal;
    vaultRoot: string;
    clockNow: () => string;
    genId: (prefix: string) => string;
  }> {
    const vaultRoot = mkdtempSync(join(tmpdir(), "vl-ttl-"));
    dir = vaultRoot;
    const git = new LedgerGit(vaultRoot);
    await git.init();
    const db = openJournal(":memory:");
    const journal = new Journal(db);
    const { now: clockNow, genId } = makeClock();
    const broker = new Broker({
      vaultRoot,
      git,
      journal,
      manifest: MANIFEST,
      now: clockNow,
      genId,
      lockDir: UNSAFE_NO_LOCK,
    });
    const store = new MemoryStore({ broker, journal, now: clockNow, genId, vaultRoot, manifest: MANIFEST });
    return { store, journal, vaultRoot, clockNow, genId };
  }

  test("archives scratch memories older than ttlDays and leaves recent ones alone", async () => {
    const { store, journal, vaultRoot } = await makeHarness();

    const old = await store.remember({ content: "old scratch", reason: "seed", session: "s1" });
    journal.updateMemory(old.id, { created: daysAgo(20) });

    const recent = await store.remember({ content: "recent scratch", reason: "seed", session: "s1" });
    journal.updateMemory(recent.id, { created: daysAgo(5) });

    const result = await sweep({
      store,
      journal,
      now: fixedNow,
      ttlDays: 14,
      stalenessDays: 30,
    });

    expect(result.archived).toEqual([old.id]);
    expect(journal.getMemory(old.id)!.status).toBe("forgotten");
    expect(existsSync(join(vaultRoot, old.path))).toBe(false);

    expect(journal.getMemory(recent.id)!.status).toBe("scratch");
    expect(existsSync(join(vaultRoot, recent.path))).toBe(true);
  });

  test("flags working memories not referenced within stalenessDays, without mutating them", async () => {
    const { store, journal } = await makeHarness();

    const stale = await store.remember({ content: "stale working", reason: "seed", session: "s1" });
    await store.promote({ id: stale.id, target_status: "working", reason: "r", session: "s1" });
    journal.updateMemory(stale.id, { last_referenced: daysAgo(40) });

    const fresh = await store.remember({ content: "fresh working", reason: "seed", session: "s1" });
    await store.promote({ id: fresh.id, target_status: "working", reason: "r", session: "s1" });
    journal.updateMemory(fresh.id, { last_referenced: daysAgo(5) });

    const result = await sweep({
      store,
      journal,
      now: fixedNow,
      ttlDays: 14,
      stalenessDays: 30,
    });

    expect(result.staleFlagged).toContain(stale.id);
    expect(result.staleFlagged).not.toContain(fresh.id);
    // Advisory only: statuses are untouched by flagging.
    expect(journal.getMemory(stale.id)!.status).toBe("working");
    expect(journal.getMemory(fresh.id)!.status).toBe("working");
  });

  test("falls back to `created` for staleness when last_referenced is null", () => {
    const rows: MemoryRow[] = [
      {
        id: "mem_a",
        path: "Agent/Memory/mem_a.md",
        entity: null,
        status: "working",
        confidence: "medium",
        created: daysAgo(40),
        source: "s1",
        supersedes: null,
        expires: null,
        last_referenced: null,
      },
      {
        id: "mem_b",
        path: "Agent/Memory/mem_b.md",
        entity: null,
        status: "working",
        confidence: "medium",
        created: daysAgo(5),
        source: "s1",
        supersedes: null,
        expires: null,
        last_referenced: null,
      },
    ];
    expect(findStale(rows, fixedNow, 30)).toEqual(["mem_a"]);
  });

  test("sweep is idempotent: a second run archives nothing new", async () => {
    const { store, journal } = await makeHarness();

    const old = await store.remember({ content: "old scratch", reason: "seed", session: "s1" });
    journal.updateMemory(old.id, { created: daysAgo(20) });

    const first = await sweep({ store, journal, now: fixedNow, ttlDays: 14, stalenessDays: 30 });
    expect(first.archived).toEqual([old.id]);

    const second = await sweep({ store, journal, now: fixedNow, ttlDays: 14, stalenessDays: 30 });
    expect(second.archived).toEqual([]);
  });

  test("sweep continues past a failed forget, records it in `failed`, and still computes staleness", async () => {
    const { store, journal, vaultRoot } = await makeHarness();

    // Two expired scratch memories; delete one's file on disk so its forget throws.
    const broken = await store.remember({ content: "broken scratch", reason: "seed", session: "s1" });
    journal.updateMemory(broken.id, { created: daysAgo(20) });
    unlinkSync(join(vaultRoot, broken.path));

    const good = await store.remember({ content: "good scratch", reason: "seed", session: "s1" });
    journal.updateMemory(good.id, { created: daysAgo(20) });

    // Plus a stale working memory so we can confirm the staleness pass still runs.
    const stale = await store.remember({ content: "stale working", reason: "seed", session: "s1" });
    await store.promote({ id: stale.id, target_status: "working", reason: "r", session: "s1" });
    journal.updateMemory(stale.id, { last_referenced: daysAgo(40) });

    const result = await sweep({ store, journal, now: fixedNow, ttlDays: 14, stalenessDays: 30 });

    expect(result.archived).toEqual([good.id]);
    expect(result.failed.map((f) => f.id)).toEqual([broken.id]);
    expect(result.staleFlagged).toContain(stale.id);
  });

  test("sweep surfaces a NaN-dated scratch memory in `malformed` instead of silently skipping it", async () => {
    const { store, journal } = await makeHarness();

    const bad = await store.remember({ content: "bad date", reason: "seed", session: "s1" });
    journal.updateMemory(bad.id, { created: "not-a-date" });

    const result = await sweep({ store, journal, now: fixedNow, ttlDays: 14, stalenessDays: 30 });

    expect(result.malformed).toContain(bad.id);
    // Not archived (we don't mutate a memory we can't date).
    expect(result.archived).not.toContain(bad.id);
    expect(journal.getMemory(bad.id)!.status).toBe("scratch");
  });
});
