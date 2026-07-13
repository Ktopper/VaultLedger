import { describe, expect, test, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  lstatSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatch } from "diff";
import { Broker } from "../../src/broker/broker.js";
import { LedgerGit } from "../../src/broker/git.js";
import { Journal } from "../../src/journal/journal.js";
import { openJournal } from "../../src/journal/db.js";
import { hashBytes, hashFile } from "../../src/broker/hash.js";
import { writeContainedFile } from "../../src/broker/containment.js";
import { BrokerError } from "../../src/errors.js";
import type { PermissionsManifest } from "../../src/schemas/manifest.js";

// VL-SEC-S1-02: symlink-swap race between containment's realpath check and
// broker.ts's leaf write. See security/poc/s1-symlink.mjs for the original
// PoC this test ports into the suite (same WindowGit synchronization-hook
// technique, deterministic rather than timing-dependent).

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

function makeClock(seed = 0): { now: () => string; genId: (prefix: string) => string } {
  let tick = seed;
  let counter = seed;
  return {
    now: () => {
      tick += 1;
      return new Date(2026, 0, 1, 0, 0, 0, tick % 1000).toISOString();
    },
    genId: (prefix: string) => {
      counter += 1;
      return `${prefix}_${counter}`;
    },
  };
}

/**
 * LedgerGit subclass that runs an arbitrary synchronous `onWindow` callback
 * (the attacker action) part-way through `fileAtHead()` -- the await point
 * broker.ts's applyRevise already has between the hash check and the leaf
 * write -- then continues. This deterministically lands the attacker's
 * filesystem swap inside the check->write window on every run instead of
 * relying on real timing.
 */
class WindowGit extends LedgerGit {
  private fired = false;
  constructor(
    dir: string,
    private readonly onWindow: () => void,
  ) {
    super(dir);
  }
  override async fileAtHead(relPath: string): Promise<string | null> {
    if (!this.fired) {
      this.fired = true;
      // Give the event loop one real tick so this genuinely interleaves
      // rather than running synchronously inline with the caller.
      await new Promise((r) => setTimeout(r, 20));
      this.onWindow();
      await new Promise((r) => setTimeout(r, 20));
    }
    return super.fileAtHead(relPath);
  }
}

describe("Broker write-path symlink containment (VL-SEC-S1-02)", () => {
  let dir: string | undefined;
  let outsideDir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
    if (outsideDir) {
      rmSync(outsideDir, { recursive: true, force: true });
      outsideDir = undefined;
    }
  });

  test("a symlink swapped into the check->write window during revise does NOT escape containment", async () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "vl-symlink-vault-"));
    dir = vaultRoot;
    const outside = mkdtempSync(join(tmpdir(), "vl-symlink-outside-"));
    outsideDir = outside;

    const relPath = "Agent/Memory/target.md";
    const absPath = join(vaultRoot, relPath);
    const outsideCanary = join(outside, "canary.txt");
    writeFileSync(outsideCanary, "CANARY-untouched\n", "utf8");

    // Seed the note via a normal create so it starts life as a real
    // git-tracked file (matches the PoC's setup).
    const seedGit = new LedgerGit(vaultRoot);
    await seedGit.init();
    const seedJournal = new Journal(openJournal(":memory:"));
    const seedBroker = new Broker({
      vaultRoot,
      git: seedGit,
      journal: seedJournal,
      manifest: MANIFEST,
      ...makeClock(0),
    });
    await seedBroker.apply({
      op: "create",
      path: relPath,
      content: "line1\n",
      reason: "seed",
      session: "seed",
    });

    const preHash = hashFile(absPath);

    // The attack: mid-operation (inside the check->write window), unlink the
    // real vault file and replace it with a symlink pointing OUTSIDE the
    // vault root, at the canary file.
    const attackerSwap = (): void => {
      unlinkSync(absPath);
      symlinkSync(outsideCanary, absPath);
    };

    const git = new WindowGit(vaultRoot, attackerSwap);
    const journal = new Journal(openJournal(":memory:"));
    const broker = new Broker({
      vaultRoot,
      git,
      journal,
      manifest: MANIFEST,
      ...makeClock(100),
    });

    const original = "line1\n";
    const patch = createPatch("target.md", original, original + "PATCHED-BY-BROKER\n");

    let thrown: unknown;
    try {
      await broker.apply({
        op: "revise",
        path: relPath,
        patch,
        expected_hash: preHash,
        reason: "symlink race",
        session: "sA",
      });
    } catch (e) {
      thrown = e;
    }

    // The op must be rejected, not silently applied.
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("FORBIDDEN_ZONE");

    // The outside canary must be byte-for-byte untouched.
    const outsideContent = readFileSync(outsideCanary, "utf8");
    expect(outsideContent).toBe("CANARY-untouched\n");
    expect(outsideContent.includes("PATCHED-BY-BROKER")).toBe(false);
  });

  test("a pre-existing outside-pointing symlink at the target is still caught statically (no window needed)", async () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "vl-symlink-static-vault-"));
    dir = vaultRoot;
    const outside = mkdtempSync(join(tmpdir(), "vl-symlink-static-outside-"));
    outsideDir = outside;

    const outsideFile = join(outside, "x.md");
    const original = "outside content\n";
    writeFileSync(outsideFile, original, "utf8");

    mkdirSync(join(vaultRoot, "Agent"), { recursive: true });
    symlinkSync(outside, join(vaultRoot, "Agent", "evil"));

    const git = new LedgerGit(vaultRoot);
    await git.init();
    const journal = new Journal(openJournal(":memory:"));
    const broker = new Broker({ vaultRoot, git, journal, manifest: MANIFEST, ...makeClock() });

    const patch = createPatch("x.md", original, original + "tampered\n");
    let thrown: unknown;
    try {
      await broker.apply({
        op: "revise",
        path: "Agent/evil/x.md",
        patch,
        expected_hash: hashBytes(Buffer.from(original, "utf8")),
        reason: "attack: static symlink escape",
        session: "s1",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BrokerError);
    expect((thrown as BrokerError).code).toBe("FORBIDDEN_ZONE");
    expect(readFileSync(outsideFile, "utf8")).toBe(original);
  });

  test("happy path: a normal in-vault revise with no symlink involved still succeeds", async () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "vl-symlink-happy-vault-"));
    dir = vaultRoot;

    const git = new LedgerGit(vaultRoot);
    await git.init();
    const journal = new Journal(openJournal(":memory:"));
    const broker = new Broker({ vaultRoot, git, journal, manifest: MANIFEST, ...makeClock() });

    const relPath = "Agent/Memory/normal.md";
    await broker.apply({
      op: "create",
      path: relPath,
      content: "line1\n",
      reason: "seed",
      session: "s1",
    });

    const absPath = join(vaultRoot, relPath);
    const original = "line1\n";
    const preHash = hashFile(absPath);
    const patch = createPatch("normal.md", original, original + "line2\n");

    const result = await broker.apply({
      op: "revise",
      path: relPath,
      patch,
      expected_hash: preHash,
      reason: "legit edit",
      session: "s1",
    });

    expect(result.ok).toBe(true);
    expect(existsSync(absPath)).toBe(true);
    expect(lstatSync(absPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(absPath, "utf8")).toBe("line1\nline2\n");
  });

  // -------------------------------------------------------------------
  // The temp-file plant vector (the bug an early version of the fix
  // introduced): a PREDICTABLE temp name + a following write (writeFileSync's
  // default 'w') would let an attacker pre-plant a symlink at the exact temp
  // path BEFORE the op — no race — so the payload write escapes and the
  // rename then moves the planted symlink onto the note. The shipped fix uses
  // an unguessable random name AND an exclusive, non-following open
  // (openSync "wx" = O_CREAT|O_EXCL|O_WRONLY). O_EXCL fails EEXIST if the path
  // exists INCLUDING as a symlink, so a planted/guessed temp fails CLOSED.
  //
  // The random suffix defeats EXTERNAL prediction, so this exercises the
  // exclusive-open fail-closed semantics directly via writeContainedFile's
  // test-only temp-name seam: pre-plant a symlink at a KNOWN temp path, then
  // assert the write throws EEXIST and the outside victim is untouched.
  // -------------------------------------------------------------------

  test("temp-plant: a symlink pre-planted at the temp path fails closed (O_EXCL EEXIST), outside untouched", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "vl-tmpplant-vault-"));
    dir = vaultRoot;
    const outside = mkdtempSync(join(tmpdir(), "vl-tmpplant-outside-"));
    outsideDir = outside;

    const outsideVictim = join(outside, "victim.txt");
    writeFileSync(outsideVictim, "VICTIM-untouched\n", "utf8");

    const rel = "Agent/Memory/note.md";
    const abs = join(vaultRoot, rel);
    mkdirSync(join(vaultRoot, "Agent", "Memory"), { recursive: true });
    writeFileSync(abs, "original\n", "utf8");

    // Attacker pre-plants a symlink -> outside victim at the KNOWN temp path
    // (in the note's own parent dir), before the governed write runs.
    const plantedTmpBasename = ".note.md.attacker-planted.vl-tmp";
    symlinkSync(outsideVictim, join(vaultRoot, "Agent", "Memory", plantedTmpBasename));

    let thrown: unknown;
    try {
      // Force the temp name to the planted path via the test-only seam.
      writeContainedFile(vaultRoot, MANIFEST, rel, "PAYLOAD-SHOULD-NOT-ESCAPE\n", plantedTmpBasename);
    } catch (e) {
      thrown = e;
    }

    // openSync("wx") on the pre-existing (symlink) path must fail EEXIST —
    // fail closed, never follow it.
    expect(thrown).toBeDefined();
    expect((thrown as NodeJS.ErrnoException).code).toBe("EEXIST");
    // The payload never reached the outside victim (the write did not follow
    // the planted symlink).
    expect(readFileSync(outsideVictim, "utf8")).toBe("VICTIM-untouched\n");
    // The real note is untouched and still a regular file (no symlink moved
    // onto it by a rename that never happened).
    expect(lstatSync(abs).isSymbolicLink()).toBe(false);
    expect(readFileSync(abs, "utf8")).toBe("original\n");
  });

  test("happy path via writeContainedFile still writes atomically when no temp collision (seam-injected name)", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "vl-tmpok-vault-"));
    dir = vaultRoot;
    const rel = "Agent/Memory/note.md";
    const abs = join(vaultRoot, rel);
    mkdirSync(join(vaultRoot, "Agent", "Memory"), { recursive: true });
    writeFileSync(abs, "before\n", "utf8");

    // A fresh (non-existing) temp name: exclusive create succeeds, rename
    // installs the content.
    writeContainedFile(vaultRoot, MANIFEST, rel, "after\n", ".note.md.fresh.vl-tmp");
    expect(lstatSync(abs).isSymbolicLink()).toBe(false);
    expect(readFileSync(abs, "utf8")).toBe("after\n");
    // No temp litter left behind.
    expect(existsSync(join(vaultRoot, "Agent", "Memory", ".note.md.fresh.vl-tmp"))).toBe(false);
  });
});
