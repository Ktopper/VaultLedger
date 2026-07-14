import { simpleGit, type SimpleGit } from "simple-git";
import { existsSync } from "node:fs";
import { BrokerError } from "../errors.js";

const IDENTITY_ARGS = ["-c", "user.name=VaultLedger", "-c", "user.email=ledger@local"];

/**
 * Build the canonical ledger commit message:
 *   ledger: <op> <basename> [<memoryId>] <session>
 * The `[<memoryId>]` segment is omitted entirely when memoryId is not given.
 */
export function formatMessage(parts: {
  op: string;
  basename: string;
  memoryId?: string;
  session: string;
}): string {
  const memorySegment = parts.memoryId ? ` [${parts.memoryId}]` : "";
  return `ledger: ${parts.op} ${parts.basename}${memorySegment} ${parts.session}`;
}

/**
 * Thin wrapper around simple-git that commits under a fixed "VaultLedger"
 * identity (independent of the user's global git config) and translates
 * `git revert` conflicts into a typed BrokerError.
 */
export class LedgerGit {
  private readonly dir: string;
  private readonly git: SimpleGit;
  // Promise-chain mutex: all mutating operations (init, commitFile,
  // revertCommit) run one-at-a-time on a given instance so overlapping calls
  // never race on git's index.lock (which would surface as a raw Error, not a
  // BrokerError, and slip past our typed error handling).
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
    this.git = simpleGit(dir);
  }

  /** Serialize a mutating operation behind any in-flight ones on this instance. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    // Keep the chain alive regardless of individual outcomes; swallow the
    // settled value here so a rejection doesn't poison later operations.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async init(): Promise<void> {
    await this.enqueue(async () => {
      const isRepo = await this.git.checkIsRepo();
      if (!isRepo) {
        await this.git.init();
      }
    });
  }

  async commitFile(relPath: string, message: string): Promise<string> {
    return this.enqueue(async () => {
      // Stage the target file, then commit ONLY that pathspec. Passing
      // `-- <relPath>` to commit guarantees any other already-staged content
      // stays staged and out of this commit, preserving the one-op-per-commit
      // invariant that undo (§5.3) relies on.
      await this.git.add([relPath]);
      await this.git.raw([...IDENTITY_ARGS, "commit", "-m", message, "--", relPath]);
      const sha = (await this.git.revparse(["HEAD"])).trim();
      return sha;
    });
  }

  /**
   * Like commitFile, but stages and commits several pathspecs as a single
   * commit. Used for move-style operations (e.g. archive-on-forget) that
   * touch two paths (delete the source, add the destination) but must still
   * land as one ledger commit.
   */
  async commitPaths(relPaths: string[], message: string): Promise<string> {
    return this.enqueue(async () => {
      await this.git.add(relPaths);
      await this.git.raw([...IDENTITY_ARGS, "commit", "-m", message, "--", ...relPaths]);
      const sha = (await this.git.revparse(["HEAD"])).trim();
      return sha;
    });
  }

  async revertCommit(sha: string): Promise<string> {
    return this.enqueue(async () => {
      try {
        await this.git.raw([...IDENTITY_ARGS, "revert", "--no-edit", sha]);
      } catch (e) {
        // Distinguish a TRUE merge conflict (flag for manual resolution) from a
        // non-conflict failure (bad/unknown sha, nothing to revert — a journal
        // integrity bug, not a conflict). Only the former is REVERT_CONFLICT.
        const conflicted = await this.hasUnmergedPaths();
        if (conflicted) {
          // Abort to restore a clean tree, then surface the typed rejection.
          await this.abortRevertIfInProgress();
          throw new BrokerError(
            "REVERT_CONFLICT",
            `git revert of ${sha} conflicted: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        // Non-conflict failure: ensure the tree is clean (abort only if a
        // revert is actually in progress) and rethrow the original git error
        // unlabeled, so callers can tell it apart from a real conflict.
        await this.abortRevertIfInProgress();
        throw e;
      }
      const newSha = (await this.git.revparse(["HEAD"])).trim();
      return newSha;
    });
  }

  /** True if the working tree has any unmerged (conflicted) paths. */
  private async hasUnmergedPaths(): Promise<boolean> {
    const status = await this.git.raw(["status", "--porcelain"]);
    for (const line of status.split("\n")) {
      if (line.length < 2) continue;
      const x = line[0];
      const y = line[1];
      // Unmerged states per `git status` docs: DD, AU, UD, UA, DU, AA, UU.
      // Any 'U' in either column, or the symmetric AA/DD pairs, marks a conflict.
      if (x === "U" || y === "U") return true;
      if ((x === "A" && y === "A") || (x === "D" && y === "D")) return true;
    }
    return false;
  }

  /** Abort an in-progress revert if (and only if) one is underway. */
  private async abortRevertIfInProgress(): Promise<void> {
    try {
      await this.git.raw(["revert", "--abort"]);
    } catch {
      // No revert in progress (or nothing to abort) — nothing to clean up.
    }
  }

  async fileAtHead(relPath: string): Promise<string | null> {
    try {
      const out = await this.git.show([`HEAD:${relPath}`]);
      return out;
    } catch {
      return null;
    }
  }

  async listLedgerCommits(): Promise<Array<{ sha: string; message: string }>> {
    let log: string;
    try {
      // %x00-separated fields, %x01-separated records to avoid ambiguity with
      // multi-line commit messages.
      log = await this.git.raw(["log", "--format=%H%x00%s%x01"]);
    } catch {
      // No commits yet.
      return [];
    }
    const records = log.split("\x01").filter((r) => r.trim().length > 0);
    const commits: Array<{ sha: string; message: string }> = [];
    for (const record of records) {
      const [sha, message] = record.replace(/^\n/, "").split("\x00");
      if (!sha || message === undefined) continue;
      if (message.startsWith("ledger:")) {
        commits.push({ sha, message });
      }
    }
    return commits;
  }
}

export interface GitProbe {
  isRepo: boolean;
  gitWorks: boolean;      // false only when the git binary itself failed to run
  head: string | null;    // resolved HEAD sha, or null on a repo with no commits yet
}

/**
 * Read-only git health probe for `ledger doctor`. Never writes. Distinguishes
 * three states doctor reports differently: not a repo, a repo with no commits
 * yet (legitimate — HEAD unresolvable is NOT an error here), and a repo with a
 * resolvable HEAD. A git binary that can't run at all surfaces as
 * `gitWorks:false` (the classic environment failure nothing else catches).
 */
export async function probeGitRepo(dir: string): Promise<GitProbe> {
  // A nonexistent path is exactly the "typo / wrong vault" input `ledger
  // doctor` exists to diagnose — treat it as "not a repo" rather than letting
  // simpleGit's constructor throw GitConstructError synchronously. gitWorks
  // stays true: a missing directory is not a broken git binary (that case
  // still surfaces below via checkIsRepo's catch → gitWorks:false).
  if (!existsSync(dir)) return { isRepo: false, gitWorks: true, head: null };
  let git: SimpleGit;
  try {
    git = simpleGit(dir);
  } catch {
    return { isRepo: false, gitWorks: true, head: null };
  }
  let isRepo: boolean;
  try {
    isRepo = await git.checkIsRepo();
  } catch {
    return { isRepo: false, gitWorks: false, head: null };
  }
  if (!isRepo) return { isRepo: false, gitWorks: true, head: null };
  try {
    const sha = (await git.revparse(["HEAD"])).trim();
    return { isRepo: true, gitWorks: true, head: sha };
  } catch {
    return { isRepo: true, gitWorks: true, head: null };
  }
}
