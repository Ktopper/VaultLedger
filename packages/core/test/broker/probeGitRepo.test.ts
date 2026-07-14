import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { probeGitRepo } from "../../src/broker/git.js";

describe("probeGitRepo", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vl-probegit-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("a non-repo directory → isRepo:false", async () => {
    const r = await probeGitRepo(dir);
    expect(r.isRepo).toBe(false);
    expect(r.gitWorks).toBe(true);
  });

  test("a fresh repo with no commits → isRepo:true, head:null (legitimate)", async () => {
    await simpleGit(dir).init();
    const r = await probeGitRepo(dir);
    expect(r.isRepo).toBe(true);
    expect(r.head).toBeNull();
  });

  test("a repo with a commit → isRepo:true, head is a sha", async () => {
    const g = simpleGit(dir);
    await g.init();
    await g.addConfig("user.email", "t@t.t");
    await g.addConfig("user.name", "t");
    await g.raw(["commit", "--allow-empty", "-m", "first"]);
    const r = await probeGitRepo(dir);
    expect(r.isRepo).toBe(true);
    expect(r.head).toMatch(/^[0-9a-f]{7,}$/);
  });

  test("a nonexistent path → isRepo:false, gitWorks:true, no throw", async () => {
    const missing = join(dir, "does", "not", "exist");
    const r = await probeGitRepo(missing);
    expect(r).toEqual({ isRepo: false, gitWorks: true, head: null });
  });
});
