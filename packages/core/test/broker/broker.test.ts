import { describe, expect, test, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatch } from "diff";
import matter from "gray-matter";
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
    // Above the 512-byte ratio-guard floor (WU-4): the guard only applies to
    // files this size, so use a genuinely large note to prove the broker's
    // revise path still propagates PATCH_TOO_LARGE where the guard is active.
    const original =
      Array.from({ length: 40 }, (_, i) => `original content line number ${i} with padding`).join("\n") + "\n";
    await createAgentFile(broker, "Agent/Memory/big.md", original);
    // Change 25 of 40 lines (>50%) so the ratio guard trips.
    const rewritten =
      Array.from({ length: 40 }, (_, i) =>
        i < 25 ? `REWRITTEN content line number ${i} with padding` : `original content line number ${i} with padding`,
      ).join("\n") + "\n";
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
  // expected_hash format guard (MALFORMED_HASH)
  // -------------------------------------------------------------------

  test("revise with a bare hex expected_hash (missing sha256: prefix) throws MALFORMED_HASH and writes nothing", async () => {
    const { broker, journal, vaultRoot, git } = await makeBroker();
    const original = "line1\nline2\nline3\n";
    await createAgentFile(broker, "Agent/Memory/malformed.md", original);
    const headBefore = await git.fileAtHead("Agent/Memory/malformed.md");

    const updated = "line1\nline2\nline3\nline4\n";
    const patchText = createPatch("malformed.md", original, updated);
    const bareHex = hashBytes(Buffer.from(original, "utf8")).slice("sha256:".length);

    let thrown: unknown;
    try {
      await broker.apply({
        op: "revise",
        path: "Agent/Memory/malformed.md",
        expected_hash: bareHex,
        patch: patchText,
        reason: "r",
        session: "s1",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("MALFORMED_HASH");

    // Nothing written to the file, nothing committed, nothing recorded.
    expect(readFileSync(join(vaultRoot, "Agent/Memory/malformed.md"), "utf8")).toBe(original);
    expect(await git.fileAtHead("Agent/Memory/malformed.md")).toBe(headBefore);
    expect(journal.listTransactions({}).some((t) => t.op === "revise")).toBe(false);
  });

  test("revise with a well-formed lowercase sha256 expected_hash applies normally", async () => {
    const { broker, vaultRoot } = await makeBroker();
    const original = "line1\nline2\nline3\n";
    await createAgentFile(broker, "Agent/Memory/lower.md", original);

    const updated = "line1\nline2\nline3\nline4\n";
    const patchText = createPatch("lower.md", original, updated);
    const expectedHash = hashBytes(Buffer.from(original, "utf8"));
    expect(expectedHash).toBe(expectedHash.toLowerCase());

    const result = await broker.apply({
      op: "revise",
      path: "Agent/Memory/lower.md",
      expected_hash: expectedHash,
      patch: patchText,
      reason: "r",
      session: "s1",
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(vaultRoot, "Agent/Memory/lower.md"), "utf8")).toBe(updated);
  });

  test("revise with an UPPERCASE-hex expected_hash of the correct digest is accepted (case-normalized), not rejected", async () => {
    const { broker, vaultRoot } = await makeBroker();
    const original = "line1\nline2\nline3\n";
    await createAgentFile(broker, "Agent/Memory/upper.md", original);

    const updated = "line1\nline2\nline3\nline4\n";
    const patchText = createPatch("upper.md", original, updated);
    const correctHash = hashBytes(Buffer.from(original, "utf8"));
    const uppercased = "sha256:" + correctHash.slice("sha256:".length).toUpperCase();

    const result = await broker.apply({
      op: "revise",
      path: "Agent/Memory/upper.md",
      expected_hash: uppercased,
      patch: patchText,
      reason: "r",
      session: "s1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok || "queued" in result) throw new Error("expected an applied result");
    expect(readFileSync(join(vaultRoot, "Agent/Memory/upper.md"), "utf8")).toBe(updated);
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

  test("propose_edit with a bare hex expected_hash (missing sha256: prefix) throws MALFORMED_HASH and queues nothing", async () => {
    const { broker, journal, vaultRoot } = await makeBroker();
    const original = "trusted content\n";
    writeFileSync(join(vaultRoot, "note-malformed.md"), original, "utf8");

    const patchText = createPatch("note-malformed.md", original, "trusted content\nmore\n");
    const bareHex = hashBytes(Buffer.from(original, "utf8")).slice("sha256:".length);

    let thrown: unknown;
    try {
      await broker.apply({
        op: "propose_edit",
        path: "note-malformed.md",
        expected_hash: bareHex,
        patch: patchText,
        reason: "r",
        session: "s1",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("MALFORMED_HASH");
    expect(journal.listApprovals().length).toBe(0);
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

  // -------------------------------------------------------------------
  // path traversal / vault-root containment (security)
  // -------------------------------------------------------------------

  test("create with a ..-traversal path is rejected FORBIDDEN_ZONE and writes NO file outside the vault", async () => {
    const { broker, vaultRoot } = await makeBroker();
    const escapeAbs = join(vaultRoot, "..", "vl-escape-create.md");
    rmSync(escapeAbs, { force: true });

    let thrown: unknown;
    try {
      await broker.apply({
        op: "create",
        path: "Agent/../../vl-escape-create.md",
        content: "escaped\n",
        reason: "attack",
        session: "s1",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("FORBIDDEN_ZONE");
    expect(existsSync(escapeAbs)).toBe(false);
  });

  test("revise with a ..-traversal path is rejected FORBIDDEN_ZONE and modifies NO file outside the vault", async () => {
    const { broker, vaultRoot } = await makeBroker();
    const escapeAbs = join(vaultRoot, "..", "vl-escape-revise.md");
    // Seed a would-be victim file OUTSIDE the vault; it must be left untouched.
    writeFileSync(escapeAbs, "original outside content\n", "utf8");

    try {
      const patchText = createPatch(
        "vl-escape-revise.md",
        "original outside content\n",
        "original outside content\ntampered\n",
      );
      let thrown: unknown;
      try {
        await broker.apply({
          op: "revise",
          path: "Agent/../../vl-escape-revise.md",
          expected_hash: hashBytes(Buffer.from("original outside content\n", "utf8")),
          patch: patchText,
          reason: "attack",
          session: "s1",
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(BrokerError);
      expect((thrown as BrokerError).code).toBe("FORBIDDEN_ZONE");
      // The outside file must be byte-identical (never opened for write).
      expect(readFileSync(escapeAbs, "utf8")).toBe("original outside content\n");
    } finally {
      rmSync(escapeAbs, { force: true });
    }
  });

  test("archive with a ..-traversal source is rejected FORBIDDEN_ZONE with no fs side effect", async () => {
    const { broker, vaultRoot } = await makeBroker();
    const escapeAbs = join(vaultRoot, "..", "vl-escape-archive-src.md");
    writeFileSync(escapeAbs, "victim\n", "utf8");

    try {
      let thrown: unknown;
      try {
        await broker.archive(
          "Agent/../../vl-escape-archive-src.md",
          "Agent/Archive/x.md",
          "s1",
          "attack",
        );
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(BrokerError);
      expect((thrown as BrokerError).code).toBe("FORBIDDEN_ZONE");
      // Source untouched, no archive destination created.
      expect(readFileSync(escapeAbs, "utf8")).toBe("victim\n");
      expect(existsSync(join(vaultRoot, "Agent/Archive/x.md"))).toBe(false);
    } finally {
      rmSync(escapeAbs, { force: true });
    }
  });

  test("archive with a ..-traversal destination is rejected FORBIDDEN_ZONE and does not delete the source", async () => {
    const { broker, vaultRoot } = await makeBroker();
    await createAgentFile(broker, "Agent/Memory/keep.md", "keep me\n");
    const escapeAbs = join(vaultRoot, "..", "vl-escape-archive-dst.md");
    rmSync(escapeAbs, { force: true });

    try {
      let thrown: unknown;
      try {
        await broker.archive(
          "Agent/Memory/keep.md",
          "Agent/../../vl-escape-archive-dst.md",
          "s1",
          "attack",
        );
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(BrokerError);
      expect((thrown as BrokerError).code).toBe("FORBIDDEN_ZONE");
      // Source not deleted, no escape file written.
      expect(readFileSync(join(vaultRoot, "Agent/Memory/keep.md"), "utf8")).toBe("keep me\n");
      expect(existsSync(escapeAbs)).toBe(false);
    } finally {
      rmSync(escapeAbs, { force: true });
    }
  });

  test("archive from an excluded zone is rejected FORBIDDEN_ZONE before any fs mutation", async () => {
    const { broker, vaultRoot } = await makeBroker();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(vaultRoot, "Private"), { recursive: true });
    writeFileSync(join(vaultRoot, "Private/secret.md"), "secret\n", "utf8");

    let thrown: unknown;
    try {
      await broker.archive("Private/secret.md", "Agent/Archive/secret.md", "s1", "attack");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("FORBIDDEN_ZONE");
    // Source untouched, no destination created.
    expect(readFileSync(join(vaultRoot, "Private/secret.md"), "utf8")).toBe("secret\n");
    expect(existsSync(join(vaultRoot, "Agent/Archive/secret.md"))).toBe(false);
  });

  test("archive into a trusted (non-agent) destination is rejected FORBIDDEN_ZONE", async () => {
    const { broker, vaultRoot } = await makeBroker();
    await createAgentFile(broker, "Agent/Memory/src.md", "content\n");

    let thrown: unknown;
    try {
      await broker.archive("Agent/Memory/src.md", "archived.md", "s1", "misroute");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("FORBIDDEN_ZONE");
    // Source not moved.
    expect(readFileSync(join(vaultRoot, "Agent/Memory/src.md"), "utf8")).toBe("content\n");
  });

  // -------------------------------------------------------------------
  // additional correctness coverage
  // -------------------------------------------------------------------

  test("revise on a missing file throws NOT_FOUND", async () => {
    const { broker } = await makeBroker();
    const patchText = createPatch("nope.md", "a\nb\nc\n", "a\nb\nc\nd\n");

    let thrown: unknown;
    try {
      await broker.apply({
        op: "revise",
        path: "Agent/Memory/nope.md",
        expected_hash: hashBytes(Buffer.from("a\nb\nc\n", "utf8")),
        patch: patchText,
        reason: "r",
        session: "s1",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("NOT_FOUND");
  });

  test("revise that corrupts frontmatter throws SYNTAX_BREAK end-to-end", async () => {
    const { broker } = await makeBroker();
    const original = "---\ntitle: X\ntags: [a]\n---\n\n# Body\nline1\nline2\n";
    await createAgentFile(broker, "Agent/Memory/fm.md", original);

    // Remove the closing `---` fence, corrupting the frontmatter block.
    const corrupted = "---\ntitle: X\ntags: [a]\n\n# Body\nline1\nline2\n";
    const patchText = createPatch("fm.md", original, corrupted);

    let thrown: unknown;
    try {
      await broker.apply({
        op: "revise",
        path: "Agent/Memory/fm.md",
        expected_hash: hashBytes(Buffer.from(original, "utf8")),
        patch: patchText,
        reason: "break structure",
        session: "s1",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("SYNTAX_BREAK");
  });

  // -------------------------------------------------------------------
  // ledger-block tamper guard (v0.3a): status/entity/supersedes governance
  // -------------------------------------------------------------------

  // Realistic memory-note shape: `entity` is a TOP-LEVEL frontmatter field, a
  // sibling of `ledger:` (MemoryProvenance has no entity), and is governed.
  const LEDGER_NOTE =
    "---\nledger:\n  status: working\n  supersedes: null\nentity: alice\n---\n\n" +
    "Alice prefers dark mode.\nShe also prefers larger fonts.\nAnd a minimal sidebar.\n" +
    "She reads mostly technical documentation.\nHer timezone is US/Pacific.\n";

  test("unapproved revise flipping ledger.status working->canonical throws LEDGER_GUARD and writes nothing", async () => {
    const { broker, journal, vaultRoot } = await makeBroker();
    await createAgentFile(broker, "Agent/Memory/lg1.md", LEDGER_NOTE);

    const tampered = LEDGER_NOTE.replace("status: working", "status: canonical");
    const patchText = createPatch("lg1.md", LEDGER_NOTE, tampered);
    const expectedHash = hashBytes(Buffer.from(LEDGER_NOTE, "utf8"));

    let thrown: unknown;
    try {
      await broker.apply({
        op: "revise",
        path: "Agent/Memory/lg1.md",
        expected_hash: expectedHash,
        patch: patchText,
        reason: "self-promote",
        session: "s1",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("LEDGER_GUARD");

    expect(readFileSync(join(vaultRoot, "Agent/Memory/lg1.md"), "utf8")).toBe(LEDGER_NOTE);
    expect(journal.listTransactions({}).some((t) => t.op === "revise")).toBe(false);
  });

  test("unapproved revise rewriting the top-level entity throws LEDGER_GUARD and writes nothing", async () => {
    const { broker, journal, vaultRoot } = await makeBroker();
    await createAgentFile(broker, "Agent/Memory/lg2.md", LEDGER_NOTE);

    // entity is a TOP-LEVEL field (not in the ledger: block) — the guard must
    // still catch it: rewriting it drops the belief from its same-entity
    // comparison set (the review found the ledger-only guard missed this).
    const tampered = LEDGER_NOTE.replace("entity: alice", "entity: bob");
    const patchText = createPatch("lg2.md", LEDGER_NOTE, tampered);
    const expectedHash = hashBytes(Buffer.from(LEDGER_NOTE, "utf8"));

    let thrown: unknown;
    try {
      await broker.apply({
        op: "revise",
        path: "Agent/Memory/lg2.md",
        expected_hash: expectedHash,
        patch: patchText,
        reason: "rewrite entity",
        session: "s1",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("LEDGER_GUARD");

    expect(readFileSync(join(vaultRoot, "Agent/Memory/lg2.md"), "utf8")).toBe(LEDGER_NOTE);
    expect(journal.listTransactions({}).some((t) => t.op === "revise")).toBe(false);
  });

  test("unapproved revise rewriting ledger.supersedes throws LEDGER_GUARD and writes nothing", async () => {
    const { broker, journal, vaultRoot } = await makeBroker();
    await createAgentFile(broker, "Agent/Memory/lg3.md", LEDGER_NOTE);

    const tampered = LEDGER_NOTE.replace("supersedes: null", "supersedes: mem_fake");
    const patchText = createPatch("lg3.md", LEDGER_NOTE, tampered);
    const expectedHash = hashBytes(Buffer.from(LEDGER_NOTE, "utf8"));

    let thrown: unknown;
    try {
      await broker.apply({
        op: "revise",
        path: "Agent/Memory/lg3.md",
        expected_hash: expectedHash,
        patch: patchText,
        reason: "fake lineage",
        session: "s1",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("LEDGER_GUARD");

    expect(readFileSync(join(vaultRoot, "Agent/Memory/lg3.md"), "utf8")).toBe(LEDGER_NOTE);
    expect(journal.listTransactions({}).some((t) => t.op === "revise")).toBe(false);
  });

  test("unapproved revise that changes only the body succeeds", async () => {
    const { broker, vaultRoot } = await makeBroker();
    await createAgentFile(broker, "Agent/Memory/lg4.md", LEDGER_NOTE);

    const updated = LEDGER_NOTE.replace(
      "Alice prefers dark mode.",
      "Alice prefers dark mode and large fonts.",
    );
    const patchText = createPatch("lg4.md", LEDGER_NOTE, updated);
    const expectedHash = hashBytes(Buffer.from(LEDGER_NOTE, "utf8"));

    const result = await broker.apply({
      op: "revise",
      path: "Agent/Memory/lg4.md",
      expected_hash: expectedHash,
      patch: patchText,
      reason: "elaborate",
      session: "s1",
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(vaultRoot, "Agent/Memory/lg4.md"), "utf8")).toBe(updated);
  });

  test("unapproved revise that changes only a non-ledger frontmatter key succeeds", async () => {
    const { broker, vaultRoot } = await makeBroker();
    const original =
      "---\nledger:\n  status: working\n  entity: alice\n  supersedes: null\ndeadline: 2026-01-01\n---\n\nBody.\n";
    await createAgentFile(broker, "Agent/Memory/lg5.md", original);

    const updated = original.replace("deadline: 2026-01-01", "deadline: 2026-02-01");
    const patchText = createPatch("lg5.md", original, updated);
    const expectedHash = hashBytes(Buffer.from(original, "utf8"));

    const result = await broker.apply({
      op: "revise",
      path: "Agent/Memory/lg5.md",
      expected_hash: expectedHash,
      patch: patchText,
      reason: "reschedule",
      session: "s1",
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(vaultRoot, "Agent/Memory/lg5.md"), "utf8")).toBe(updated);
  });

  test("revise passed { approved: true } that flips ledger.status succeeds (legit flip path unblocked)", async () => {
    const { broker, vaultRoot } = await makeBroker();
    await createAgentFile(broker, "Agent/Memory/lg6.md", LEDGER_NOTE);

    const flipped = LEDGER_NOTE.replace("status: working", "status: canonical");
    const patchText = createPatch("lg6.md", LEDGER_NOTE, flipped);
    const expectedHash = hashBytes(Buffer.from(LEDGER_NOTE, "utf8"));

    const result = await broker.apply(
      {
        op: "revise",
        path: "Agent/Memory/lg6.md",
        expected_hash: expectedHash,
        patch: patchText,
        reason: "approved promotion",
        session: "s1",
      },
      { approved: true },
    );
    expect(result.ok).toBe(true);
    const onDisk = readFileSync(join(vaultRoot, "Agent/Memory/lg6.md"), "utf8");
    expect(matter(onDisk).data.ledger.status).toBe("canonical");
  });

  // -------------------------------------------------------------------
  // security: .ledger is the security policy itself and must never be
  // agent-writable, even if a (malicious or misconfigured) manifest tries
  // to make "**" trusted (fix 1).
  // -------------------------------------------------------------------

  test("propose_edit on .ledger/permissions.yaml throws FORBIDDEN_ZONE, not a queued approval", async () => {
    const { broker, journal, vaultRoot } = await makeBroker();
    mkdirSync(join(vaultRoot, ".ledger"), { recursive: true });
    const original = "zones:\n  trusted: ['**']\n";
    writeFileSync(join(vaultRoot, ".ledger/permissions.yaml"), original, "utf8");

    const patchText = createPatch(
      "permissions.yaml",
      original,
      "zones:\n  trusted: ['**']\n  agent: ['**']\n",
    );

    let thrown: unknown;
    try {
      await broker.apply({
        op: "propose_edit",
        path: ".ledger/permissions.yaml",
        expected_hash: hashBytes(Buffer.from(original, "utf8")),
        patch: patchText,
        reason: "attack: widen own zones via propose_edit",
        session: "s1",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("FORBIDDEN_ZONE");
    // Must not be queued for approval at all.
    expect(journal.listApprovals("pending").length).toBe(0);
    // File bytes unchanged.
    expect(readFileSync(join(vaultRoot, ".ledger/permissions.yaml"), "utf8")).toBe(original);
  });

  // -------------------------------------------------------------------
  // security: symlink escape must not defeat vault-root containment
  // (fix 3). A symlink INSIDE the vault pointing OUTSIDE it would let a
  // lexically-contained path (Agent/evil/x.md) physically write outside
  // the vault root.
  // -------------------------------------------------------------------

  test("create through a symlink that escapes the vault root throws FORBIDDEN_ZONE and writes nothing outside", async () => {
    const { broker, vaultRoot } = await makeBroker();
    const outsideDir = mkdtempSync(join(tmpdir(), "vl-outside-"));
    try {
      mkdirSync(join(vaultRoot, "Agent"), { recursive: true });
      symlinkSync(outsideDir, join(vaultRoot, "Agent", "evil"));

      let thrown: unknown;
      try {
        await broker.apply({
          op: "create",
          path: "Agent/evil/pwned.md",
          content: "pwned\n",
          reason: "attack: symlink escape",
          session: "s1",
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(BrokerError);
      expect((thrown as BrokerError).code).toBe("FORBIDDEN_ZONE");
      expect(existsSync(join(outsideDir, "pwned.md"))).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("revise through a symlinked ancestor directory throws FORBIDDEN_ZONE", async () => {
    const { broker, vaultRoot } = await makeBroker();
    const outsideDir = mkdtempSync(join(tmpdir(), "vl-outside-revise-"));
    try {
      const outsideFile = join(outsideDir, "x.md");
      const original = "outside content\n";
      writeFileSync(outsideFile, original, "utf8");

      mkdirSync(join(vaultRoot, "Agent"), { recursive: true });
      symlinkSync(outsideDir, join(vaultRoot, "Agent", "evil"));

      const patchText = createPatch("x.md", original, original + "tampered\n");
      let thrown: unknown;
      try {
        await broker.apply({
          op: "revise",
          path: "Agent/evil/x.md",
          expected_hash: hashBytes(Buffer.from(original, "utf8")),
          patch: patchText,
          reason: "attack: symlink escape via revise",
          session: "s1",
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(BrokerError);
      expect((thrown as BrokerError).code).toBe("FORBIDDEN_ZONE");
      expect(readFileSync(outsideFile, "utf8")).toBe(original);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("a normal deep create with non-existent parent directories still succeeds (realpath walk doesn't break legitimate nesting)", async () => {
    const { broker, vaultRoot } = await makeBroker();
    const result = await broker.apply({
      op: "create",
      path: "Agent/Memory/sub/deep/note.md",
      content: "deep note\n",
      reason: "legit deep create",
      session: "s1",
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(vaultRoot, "Agent/Memory/sub/deep/note.md"), "utf8")).toBe(
      "deep note\n",
    );
  });

  test("a raw 'distill' op passed directly to broker.apply is rejected (store-resolved, mirrors promote/forget)", async () => {
    const { broker } = await makeBroker();
    let thrown: unknown;
    try {
      await broker.apply({
        op: "distill",
        content: "a distillation",
        sources: ["mem_1", "mem_2"],
        reason: "summarize",
        session: "s1",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("NOT_FOUND");
  });
});
