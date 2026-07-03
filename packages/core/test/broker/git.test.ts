import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { LedgerGit, formatMessage } from "../../src/broker/git.js";
import { BrokerError } from "../../src/errors.js";

describe("formatMessage", () => {
  test("includes memoryId segment when provided", () => {
    expect(
      formatMessage({
        op: "revise",
        basename: "Nova.md",
        memoryId: "mem_8f3a",
        session: "session-a",
      }),
    ).toBe("ledger: revise Nova.md [mem_8f3a] session-a");
  });

  test("omits memoryId segment when not provided", () => {
    expect(
      formatMessage({
        op: "create",
        basename: "x.md",
        session: "session-a",
      }),
    ).toBe("ledger: create x.md session-a");
  });
});

describe("LedgerGit", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  function makeDir(): string {
    const d = mkdtempSync(join(tmpdir(), "vl-git-"));
    dir = d;
    return d;
  }

  test("commitFile creates a commit authored by VaultLedger <ledger@local>", async () => {
    const repoDir = makeDir();
    const lg = new LedgerGit(repoDir);
    await lg.init();

    writeFileSync(join(repoDir, "note.md"), "# Note\n\nHello.\n", "utf8");
    const sha = await lg.commitFile("note.md", formatMessage({ op: "create", basename: "note.md", session: "s1" }));
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const git = simpleGit(repoDir);
    const authorLine = await git.raw(["log", "-1", "--format=%an <%ae>"]);
    expect(authorLine.trim()).toBe("VaultLedger <ledger@local>");
    const committerLine = await git.raw(["log", "-1", "--format=%cn <%ce>"]);
    expect(committerLine.trim()).toBe("VaultLedger <ledger@local>");
  });

  test("round-trip: fileAtHead reflects committed content, revertCommit undoes a later commit", async () => {
    const repoDir = makeDir();
    const lg = new LedgerGit(repoDir);
    await lg.init();

    writeFileSync(join(repoDir, "note.md"), "line1\n", "utf8");
    const shaA = await lg.commitFile(
      "note.md",
      formatMessage({ op: "create", basename: "note.md", session: "s1" }),
    );
    expect(await lg.fileAtHead("note.md")).toBe("line1\n");

    writeFileSync(join(repoDir, "note.md"), "line1\nline2\n", "utf8");
    await lg.commitFile("note.md", formatMessage({ op: "revise", basename: "note.md", session: "s1" }));
    expect(await lg.fileAtHead("note.md")).toBe("line1\nline2\n");

    // Revert the second commit (HEAD) — should cleanly undo back to line1 only content
    const headSha = (await simpleGit(repoDir).revparse(["HEAD"])).trim();
    const revertSha = await lg.revertCommit(headSha);
    expect(revertSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await lg.fileAtHead("note.md")).toBe("line1\n");
    void shaA;
  });

  test("fileAtHead returns null for an absent file", async () => {
    const repoDir = makeDir();
    const lg = new LedgerGit(repoDir);
    await lg.init();
    expect(await lg.fileAtHead("missing.md")).toBeNull();
  });

  test("revertCommit throws BrokerError REVERT_CONFLICT on conflict and leaves tree clean", async () => {
    const repoDir = makeDir();
    const lg = new LedgerGit(repoDir);
    await lg.init();

    writeFileSync(join(repoDir, "note.md"), "alpha\nbeta\ngamma\n", "utf8");
    const shaA = await lg.commitFile(
      "note.md",
      formatMessage({ op: "create", basename: "note.md", session: "s1" }),
    );

    // Commit B modifies the same lines A introduced, so reverting A conflicts.
    writeFileSync(join(repoDir, "note.md"), "ALPHA\nBETA\nGAMMA\n", "utf8");
    await lg.commitFile("note.md", formatMessage({ op: "revise", basename: "note.md", session: "s1" }));

    await expect(lg.revertCommit(shaA)).rejects.toThrow(BrokerError);
    try {
      await lg.revertCommit(shaA);
      throw new Error("expected revertCommit to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrokerError);
      expect((e as BrokerError).code).toBe("REVERT_CONFLICT");
    }

    const git = simpleGit(repoDir);
    const status = await git.raw(["status", "--porcelain"]);
    expect(status.trim()).toBe("");
  });

  test("listLedgerCommits returns only ledger:-prefixed commits, newest first", async () => {
    const repoDir = makeDir();
    const lg = new LedgerGit(repoDir);
    await lg.init();

    writeFileSync(join(repoDir, "a.md"), "a\n", "utf8");
    const shaA = await lg.commitFile(
      "a.md",
      formatMessage({ op: "create", basename: "a.md", session: "s1" }),
    );

    // A non-ledger commit interleaved should be excluded.
    writeFileSync(join(repoDir, "b.md"), "b\n", "utf8");
    const git = simpleGit(repoDir);
    await git.add(["b.md"]);
    await git.raw([
      "-c",
      "user.name=Someone Else",
      "-c",
      "user.email=someone@example.com",
      "commit",
      "-m",
      "unrelated: not a ledger commit",
    ]);

    writeFileSync(join(repoDir, "a.md"), "a\na2\n", "utf8");
    const shaC = await lg.commitFile(
      "a.md",
      formatMessage({ op: "revise", basename: "a.md", session: "s1" }),
    );

    const commits = await lg.listLedgerCommits();
    expect(commits.map((c) => c.sha)).toEqual([shaC, shaA]);
    for (const c of commits) {
      expect(c.message.startsWith("ledger:")).toBe(true);
    }
  });

  test("commitFile commits ONLY relPath, leaving other staged content uncommitted", async () => {
    const repoDir = makeDir();
    const lg = new LedgerGit(repoDir);
    await lg.init();

    const git = simpleGit(repoDir);
    // Stage an unrelated file b.md before committing a.md.
    writeFileSync(join(repoDir, "b.md"), "b content\n", "utf8");
    await git.add(["b.md"]);

    writeFileSync(join(repoDir, "a.md"), "a content\n", "utf8");
    await lg.commitFile("a.md", formatMessage({ op: "create", basename: "a.md", session: "s1" }));

    // The commit must contain ONLY a.md.
    const nameOnly = await git.raw(["show", "--name-only", "--format=", "HEAD"]);
    const files = nameOnly
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(files).toEqual(["a.md"]);

    // b.md must still be staged (index) and not yet committed.
    const status = await git.raw(["status", "--porcelain"]);
    expect(status).toContain("b.md");
    // Confirm b.md is not in HEAD.
    expect(await lg.fileAtHead("b.md")).toBeNull();
  });

  test("revertCommit on a bad sha throws a non-REVERT_CONFLICT error and leaves the tree clean", async () => {
    const repoDir = makeDir();
    const lg = new LedgerGit(repoDir);
    await lg.init();

    writeFileSync(join(repoDir, "note.md"), "alpha\n", "utf8");
    await lg.commitFile("note.md", formatMessage({ op: "create", basename: "note.md", session: "s1" }));

    const badSha = "0000000000000000000000000000000000000000";
    let thrown: unknown;
    try {
      await lg.revertCommit(badSha);
      throw new Error("expected revertCommit to throw");
    } catch (e) {
      thrown = e;
    }
    // It must NOT be mislabeled as a merge conflict.
    if (thrown instanceof BrokerError) {
      expect(thrown.code).not.toBe("REVERT_CONFLICT");
    }

    const git = simpleGit(repoDir);
    const status = await git.raw(["status", "--porcelain"]);
    expect(status.trim()).toBe("");
  });

  test("concurrent commitFile calls both land without a raw index.lock error", async () => {
    const repoDir = makeDir();
    const lg = new LedgerGit(repoDir);
    await lg.init();

    // Seed an initial commit so HEAD exists.
    writeFileSync(join(repoDir, "seed.md"), "seed\n", "utf8");
    await lg.commitFile("seed.md", formatMessage({ op: "create", basename: "seed.md", session: "s1" }));

    const git = simpleGit(repoDir);
    const before = (await git.raw(["rev-list", "--count", "HEAD"])).trim();

    writeFileSync(join(repoDir, "c1.md"), "c1\n", "utf8");
    writeFileSync(join(repoDir, "c2.md"), "c2\n", "utf8");

    const results = await Promise.all([
      lg.commitFile("c1.md", formatMessage({ op: "create", basename: "c1.md", session: "s1" })),
      lg.commitFile("c2.md", formatMessage({ op: "create", basename: "c2.md", session: "s1" })),
    ]);
    for (const sha of results) {
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    }
    // Two distinct commits landed.
    expect(new Set(results).size).toBe(2);
    const after = (await git.raw(["rev-list", "--count", "HEAD"])).trim();
    expect(Number(after) - Number(before)).toBe(2);
  });
});
