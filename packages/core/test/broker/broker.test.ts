import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatch } from "diff";
import { Broker } from "../../src/broker/broker.js";
import { LedgerGit } from "../../src/broker/git.js";
import { Journal } from "../../src/journal/journal.js";
import { openJournal } from "../../src/journal/db.js";
import { hashBytes } from "../../src/broker/hash.js";
import { BrokerError } from "../../src/errors.js";
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

describe("Broker", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  async function makeBroker(manifest: PermissionsManifest = MANIFEST): Promise<{
    broker: Broker;
    journal: Journal;
    git: LedgerGit;
    vaultRoot: string;
  }> {
    const vaultRoot = mkdtempSync(join(tmpdir(), "vl-broker-"));
    dir = vaultRoot;
    const git = new LedgerGit(vaultRoot);
    await git.init();
    const db = openJournal(":memory:");
    const journal = new Journal(db);
    const { now, genId } = makeClock();
    const broker = new Broker({ vaultRoot, git, journal, manifest, now, genId });
    return { broker, journal, git, vaultRoot };
  }

  // -------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------

  test("create in agent zone writes the file, commits, and records a transaction", async () => {
    const { broker, journal, vaultRoot } = await makeBroker();

    const result = await broker.apply({
      op: "create",
      path: "Agent/Memory/x.md",
      content: "# Hello\n",
      reason: "test create",
      session: "s1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok || "queued" in result) throw new Error("expected an applied result");
    expect(result.txnId).toBeDefined();
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);

    const written = readFileSync(join(vaultRoot, "Agent/Memory/x.md"), "utf8");
    expect(written).toBe("# Hello\n");

    const txn = journal.getTransaction(result.txnId!);
    expect(txn).not.toBeNull();
    expect(txn!.op).toBe("create");
    expect(txn!.path).toBe("Agent/Memory/x.md");
    expect(txn!.hash_before).toBeNull();
    expect(txn!.hash_after).toBe(hashBytes(Buffer.from("# Hello\n", "utf8")));
    expect(txn!.status).toBe("applied");
    expect(txn!.commit_sha).toBe(result.commitSha);
  });

  test("create onto an existing path throws TARGET_EXISTS", async () => {
    const { broker, vaultRoot } = await makeBroker();
    await broker.apply({
      op: "create",
      path: "Agent/Memory/dup.md",
      content: "first\n",
      reason: "r",
      session: "s1",
    });

    let thrown: unknown;
    try {
      await broker.apply({
        op: "create",
        path: "Agent/Memory/dup.md",
        content: "second\n",
        reason: "r",
        session: "s1",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("TARGET_EXISTS");
    // Original content must be untouched.
    expect(readFileSync(join(vaultRoot, "Agent/Memory/dup.md"), "utf8")).toBe("first\n");
  });

  test("create into an excluded path throws FORBIDDEN_ZONE", async () => {
    const { broker } = await makeBroker();
    await expect(
      broker.apply({
        op: "create",
        path: "Private/secret.md",
        content: "shh\n",
        reason: "r",
        session: "s1",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ZONE" });
  });

  test("create into a trusted (non-agent) path throws FORBIDDEN_ZONE", async () => {
    const { broker } = await makeBroker();
    let thrown: unknown;
    try {
      await broker.apply({
        op: "create",
        path: "notes.md",
        content: "hi\n",
        reason: "r",
        session: "s1",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("FORBIDDEN_ZONE");
  });

  // -------------------------------------------------------------------
  // revise
  // -------------------------------------------------------------------

  async function createAgentFile(
    broker: Broker,
    path: string,
    content: string,
  ): Promise<void> {
    await broker.apply({ op: "create", path, content, reason: "seed", session: "s1" });
  }

  test("revise happy path in agent zone applies the patch and records before/after hashes", async () => {
    const { broker, journal, vaultRoot } = await makeBroker();
    const original = "line1\nline2\nline3\n";
    await createAgentFile(broker, "Agent/Memory/rev.md", original);

    const updated = "line1\nline2\nline3\nline4\n";
    const patchText = createPatch("rev.md", original, updated);
    const expectedHash = hashBytes(Buffer.from(original, "utf8"));

    const result = await broker.apply({
      op: "revise",
      path: "Agent/Memory/rev.md",
      expected_hash: expectedHash,
      patch: patchText,
      reason: "append line2",
      session: "s1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok || "queued" in result) throw new Error("expected an applied result");

    const written = readFileSync(join(vaultRoot, "Agent/Memory/rev.md"), "utf8");
    expect(written).toBe(updated);

    const txn = journal.getTransaction(result.txnId!);
    expect(txn!.hash_before).toBe(expectedHash);
    expect(txn!.hash_after).toBe(hashBytes(Buffer.from(updated, "utf8")));
  });

  test("revise with a wrong expected_hash throws STALE_HASH", async () => {
    const { broker } = await makeBroker();
    const original = "line1\n";
    await createAgentFile(broker, "Agent/Memory/rev2.md", original);

    const patchText = createPatch("rev2.md", original, "line1\nline2\n");

    let thrown: unknown;
    try {
      await broker.apply({
        op: "revise",
        path: "Agent/Memory/rev2.md",
        expected_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        patch: patchText,
        reason: "r",
        session: "s1",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("STALE_HASH");
  });

  test("revise in an excluded zone throws FORBIDDEN_ZONE", async () => {
    const { broker, vaultRoot } = await makeBroker();
    // Seed the excluded file directly on disk (broker.create cannot write there).
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(vaultRoot, "Private"), { recursive: true });
    const original = "secret\n";
    writeFileSync(join(vaultRoot, "Private/x.md"), original, "utf8");

    const patchText = createPatch("x.md", original, "secret2\n");
    let thrown: unknown;
    try {
      await broker.apply({
        op: "revise",
        path: "Private/x.md",
        expected_hash: hashBytes(Buffer.from(original, "utf8")),
        patch: patchText,
        reason: "r",
        session: "s1",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("FORBIDDEN_ZONE");
  });

  test("revise in trusted zone without approved throws APPROVAL_REQUIRED; with approved:true it applies", async () => {
    const { broker, vaultRoot } = await makeBroker();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(vaultRoot, { recursive: true });
    const original = "trusted line1\ntrusted line2\ntrusted line3\n";
    writeFileSync(join(vaultRoot, "notes.md"), original, "utf8");

    const updated = "trusted line1\ntrusted line2\ntrusted line3\ntrusted line4\n";
    const patchText = createPatch("notes.md", original, updated);
    const expectedHash = hashBytes(Buffer.from(original, "utf8"));

    let thrown: unknown;
    try {
      await broker.apply({
        op: "revise",
        path: "notes.md",
        expected_hash: expectedHash,
        patch: patchText,
        reason: "r",
        session: "s1",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("APPROVAL_REQUIRED");

    const result = await broker.apply(
      {
        op: "revise",
        path: "notes.md",
        expected_hash: expectedHash,
        patch: patchText,
        reason: "r",
        session: "s1",
      },
      { approved: true },
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(vaultRoot, "notes.md"), "utf8")).toBe(updated);
  });

  test("revise with a patch that changes >50% of the file propagates PATCH_TOO_LARGE", async () => {
    const { broker } = await makeBroker();
    const original = "a\nb\nc\nd\n";
    await createAgentFile(broker, "Agent/Memory/big.md", original);
    const rewritten = "A\nB\nC\nD\n";
    const patchText = createPatch("big.md", original, rewritten);

    let thrown: unknown;
    try {
      await broker.apply({
        op: "revise",
        path: "Agent/Memory/big.md",
        expected_hash: hashBytes(Buffer.from(original, "utf8")),
        patch: patchText,
        reason: "r",
        session: "s1",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("PATCH_TOO_LARGE");
  });

  // -------------------------------------------------------------------
  // propose_edit
  // -------------------------------------------------------------------

  test("propose_edit on a trusted note queues an approval and leaves the file untouched", async () => {
    const { broker, journal, vaultRoot } = await makeBroker();
    const original = "trusted content\n";
    writeFileSync(join(vaultRoot, "note.md"), original, "utf8");

    const patchText = createPatch("note.md", original, "trusted content\nmore\n");
    const result = await broker.apply({
      op: "propose_edit",
      path: "note.md",
      expected_hash: hashBytes(Buffer.from(original, "utf8")),
      patch: patchText,
      reason: "suggest an addition",
      session: "s1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !("queued" in result) || !result.queued) {
      throw new Error("expected a queued result");
    }
    expect(result.approvalId).toBeDefined();

    // File bytes unchanged.
    expect(readFileSync(join(vaultRoot, "note.md"), "utf8")).toBe(original);

    const approval = journal.getApproval(result.approvalId);
    expect(approval).not.toBeNull();
    expect(approval!.state).toBe("pending");
    expect(approval!.zone).toBe("trusted");
    const held = JSON.parse(approval!.held_operation);
    expect(held.op).toBe("propose_edit");
    expect(held.path).toBe("note.md");
  });

  test("propose_edit on an excluded path throws FORBIDDEN_ZONE", async () => {
    const { broker, vaultRoot } = await makeBroker();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(vaultRoot, "Private"), { recursive: true });
    const original = "secret\n";
    writeFileSync(join(vaultRoot, "Private/x.md"), original, "utf8");
    const patchText = createPatch("x.md", original, "secret2\n");

    let thrown: unknown;
    try {
      await broker.apply({
        op: "propose_edit",
        path: "Private/x.md",
        expected_hash: hashBytes(Buffer.from(original, "utf8")),
        patch: patchText,
        reason: "r",
        session: "s1",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("FORBIDDEN_ZONE");
  });

  // -------------------------------------------------------------------
  // archive (used by the memory store's forget flow)
  // -------------------------------------------------------------------

  test("archive moves a file, commits the move as one transaction, and records op='forget'", async () => {
    const { broker, journal, vaultRoot } = await makeBroker();
    await createAgentFile(broker, "Agent/Memory/gone.md", "to be archived\n");

    const result = await broker.archive(
      "Agent/Memory/gone.md",
      "Agent/Archive/gone.md",
      "s1",
      "archiving on forget",
    );

    expect(result.ok).toBe(true);
    if (!result.ok || "queued" in result) throw new Error("expected an applied result");

    expect(existsSync(join(vaultRoot, "Agent/Memory/gone.md"))).toBe(false);
    expect(readFileSync(join(vaultRoot, "Agent/Archive/gone.md"), "utf8")).toBe(
      "to be archived\n",
    );

    const txn = journal.getTransaction(result.txnId!);
    expect(txn!.op).toBe("forget");
    expect(txn!.commit_sha).toMatch(/^[0-9a-f]{40}$/);
  });
});
