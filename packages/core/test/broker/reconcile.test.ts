import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerGit, formatMessage } from "../../src/broker/git.js";
import { Journal, type TransactionRow } from "../../src/journal/journal.js";
import { openJournal } from "../../src/journal/db.js";
import { reconcile } from "../../src/broker/reconcile.js";

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

describe("reconcile", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  async function makeHarness(): Promise<{
    journal: Journal;
    git: LedgerGit;
    vaultRoot: string;
    now: () => string;
    genId: (prefix: string) => string;
  }> {
    const vaultRoot = mkdtempSync(join(tmpdir(), "vl-reconcile-"));
    dir = vaultRoot;
    const git = new LedgerGit(vaultRoot);
    await git.init();
    const db = openJournal(":memory:");
    const journal = new Journal(db);
    const { now, genId } = makeClock();
    return { journal, git, vaultRoot, now, genId };
  }

  test("repairs a commit missing from the journal (simulated crash gap) and parses op/session/memoryId", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();

    // Commit 1: recorded normally in the journal (as the broker would do).
    writeFileSync(join(vaultRoot, "a.md"), "a content\n", "utf8");
    const shaA = await git.commitFile(
      "a.md",
      formatMessage({ op: "create", basename: "a.md", session: "session-a" }),
    );
    const txnA: TransactionRow = {
      id: genId("txn"),
      op: "create",
      path: "a.md",
      hash_before: null,
      hash_after: "sha256:deadbeef",
      session: "session-a",
      reason: "seed",
      memory_id: null,
      commit_sha: shaA,
      created_at: now(),
      status: "applied",
    };
    journal.recordTransaction(txnA);

    // Commit 2: lands in git, but the process "crashes" before the journal
    // write happens — this is the gap reconcile must repair. Include a
    // memoryId segment to verify message parsing.
    writeFileSync(join(vaultRoot, "b.md"), "b content\n", "utf8");
    const shaB = await git.commitFile(
      "b.md",
      formatMessage({
        op: "revise",
        basename: "b.md",
        memoryId: "mem_7f2a",
        session: "session-b",
      }),
    );

    expect(journal.hasCommit(shaA)).toBe(true);
    expect(journal.hasCommit(shaB)).toBe(false);

    const result = await reconcile({ git, journal, now, genId });
    expect(result.repaired).toBe(1);

    expect(journal.hasCommit(shaB)).toBe(true);
    const repairedRow = journal
      .listTransactions({})
      .find((t) => t.commit_sha === shaB);
    expect(repairedRow).toBeDefined();
    expect(repairedRow!.op).toBe("revise");
    expect(repairedRow!.path).toBe("b.md");
    expect(repairedRow!.session).toBe("session-b");
    expect(repairedRow!.memory_id).toBe("mem_7f2a");
    expect(repairedRow!.status).toBe("applied");
    expect(repairedRow!.commit_sha).toBe(shaB);
  });

  test("is idempotent: a second run repairs nothing further", async () => {
    const { journal, git, vaultRoot, now, genId } = await makeHarness();

    writeFileSync(join(vaultRoot, "only.md"), "content\n", "utf8");
    await git.commitFile(
      "only.md",
      formatMessage({ op: "create", basename: "only.md", session: "session-a" }),
    );
    // Nothing recorded in the journal for this commit — simulate the gap.

    const first = await reconcile({ git, journal, now, genId });
    expect(first.repaired).toBe(1);

    const second = await reconcile({ git, journal, now, genId });
    expect(second.repaired).toBe(0);
  });
});
