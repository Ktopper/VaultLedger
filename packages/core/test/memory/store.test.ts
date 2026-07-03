import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { createPatch } from "diff";
import { Broker } from "../../src/broker/broker.js";
import { LedgerGit } from "../../src/broker/git.js";
import { Journal } from "../../src/journal/journal.js";
import { openJournal } from "../../src/journal/db.js";
import { hashFile } from "../../src/broker/hash.js";
import { BrokerError } from "../../src/errors.js";
import { MemoryStore } from "../../src/memory/store.js";
import type { PermissionsManifest } from "../../src/schemas/manifest.js";

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

describe("MemoryStore", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  async function makeStore(): Promise<{
    store: MemoryStore;
    journal: Journal;
    vaultRoot: string;
  }> {
    const vaultRoot = mkdtempSync(join(tmpdir(), "vl-memstore-"));
    dir = vaultRoot;
    const git = new LedgerGit(vaultRoot);
    await git.init();
    const db = openJournal(":memory:");
    const journal = new Journal(db);
    const { now, genId } = makeClock();
    const broker = new Broker({ vaultRoot, git, journal, manifest: MANIFEST, now, genId });
    const store = new MemoryStore({ broker, journal, now, genId, vaultRoot });
    return { store, journal, vaultRoot };
  }

  test("remember creates a note under Agent/Memory with ledger frontmatter and a journal row", async () => {
    const { store, journal, vaultRoot } = await makeStore();

    const { id, path } = await store.remember({
      content: "Alice prefers dark mode.",
      entity: "alice",
      reason: "observed preference",
      session: "s1",
      tags: ["preferences", "ui"],
    });

    expect(path).toBe(`Agent/Memory/${id}.md`);
    const raw = readFileSync(join(vaultRoot, path), "utf8");
    const parsed = matter(raw);
    expect(parsed.data.ledger).toMatchObject({
      id,
      status: "scratch",
      source: "s1",
      reason: "observed preference",
      confidence: "medium",
      supersedes: null,
      expires: null,
    });
    expect(parsed.content.trim()).toBe("Alice prefers dark mode.");

    const row = journal.getMemory(id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("scratch");
    expect(row!.entity).toBe("alice");
    expect(row!.path).toBe(path);
    expect(journal.getTags(id).sort()).toEqual(["preferences", "ui"]);
  });

  test("revise patches the note through the broker", async () => {
    const { store, vaultRoot } = await makeStore();
    const { id, path } = await store.remember({
      content: "line1\nline2",
      reason: "seed",
      session: "s1",
    });

    const before = readFileSync(join(vaultRoot, path), "utf8");
    const after = before + "\nline3";
    const patchText = createPatch(path, before, after);

    await store.revise({ id, patch: patchText, reason: "append line3", session: "s1" });

    const written = readFileSync(join(vaultRoot, path), "utf8");
    expect(written).toBe(after);
  });

  test("promote scratch -> working updates the journal row and returns promoted:true", async () => {
    const { store, journal } = await makeStore();
    const { id } = await store.remember({ content: "x", reason: "seed", session: "s1" });

    const result = await store.promote({
      id,
      target_status: "working",
      reason: "confirmed twice",
      session: "s1",
    });

    expect(result).toEqual({ promoted: true });
    expect(journal.getMemory(id)!.status).toBe("working");
  });

  test("promote working -> canonical enqueues an approval and returns promoted:false", async () => {
    const { store, journal } = await makeStore();
    const { id } = await store.remember({ content: "x", reason: "seed", session: "s1" });
    await store.promote({ id, target_status: "working", reason: "r", session: "s1" });

    const result = await store.promote({
      id,
      target_status: "canonical",
      reason: "well-established fact",
      session: "s1",
    });

    expect(result.promoted).toBe(false);
    expect(result.approvalId).toBeDefined();
    const approval = journal.getApproval(result.approvalId!);
    expect(approval).not.toBeNull();
    expect(approval!.state).toBe("pending");
    // Memory row should remain "working" until the approval resolves.
    expect(journal.getMemory(id)!.status).toBe("working");
  });

  test("promote scratch -> canonical directly is an unsupported transition", async () => {
    const { store } = await makeStore();
    const { id } = await store.remember({ content: "x", reason: "seed", session: "s1" });

    let thrown: unknown;
    try {
      await store.promote({ id, target_status: "canonical", reason: "r", session: "s1" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("INVALID_TRANSITION");
  });

  test("forget archives the file and tombstones the journal row", async () => {
    const { store, journal, vaultRoot } = await makeStore();
    const { id, path } = await store.remember({ content: "to be forgotten", reason: "seed", session: "s1" });
    expect(existsSync(join(vaultRoot, path))).toBe(true);

    await store.forget({ id, reason: "no longer relevant", session: "s1" });

    expect(existsSync(join(vaultRoot, path))).toBe(false);
    const archivePath = `Agent/Archive/${id}.md`;
    expect(existsSync(join(vaultRoot, archivePath))).toBe(true);

    const row = journal.getMemory(id);
    expect(row!.status).toBe("forgotten");
    expect(row!.path).toBe(archivePath);
  });

  test("revise computes expected_hash via hashFile against the current on-disk content", async () => {
    const { store, vaultRoot } = await makeStore();
    const { id, path } = await store.remember({ content: "v1", reason: "seed", session: "s1" });
    const onDisk = readFileSync(join(vaultRoot, path), "utf8");
    expect(hashFile(join(vaultRoot, path))).toBeDefined();

    const patchText = createPatch(path, onDisk, onDisk + "\nv2");
    await store.revise({ id, patch: patchText, reason: "add v2", session: "s1" });
    expect(readFileSync(join(vaultRoot, path), "utf8")).toBe(onDisk + "\nv2");
  });
});
