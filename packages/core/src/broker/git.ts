import { simpleGit, type SimpleGit } from "simple-git";
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

  constructor(dir: string) {
    this.dir = dir;
    this.git = simpleGit(dir);
  }

  async init(): Promise<void> {
    const isRepo = await this.git.checkIsRepo();
    if (!isRepo) {
      await this.git.init();
    }
  }

  async commitFile(relPath: string, message: string): Promise<string> {
    await this.git.add([relPath]);
    await this.git.raw([...IDENTITY_ARGS, "commit", "-m", message]);
    const sha = (await this.git.revparse(["HEAD"])).trim();
    return sha;
  }

  async revertCommit(sha: string): Promise<string> {
    try {
      await this.git.raw([...IDENTITY_ARGS, "revert", "--no-edit", sha]);
    } catch (e) {
      // Revert failed (typically a conflict). Abort to leave a clean tree,
      // then surface a typed rejection.
      try {
        await this.git.raw(["revert", "--abort"]);
      } catch {
        // If there's nothing to abort (e.g. some other failure mode),
        // ignore — we still report the original failure below.
      }
      throw new BrokerError(
        "REVERT_CONFLICT",
        `git revert of ${sha} conflicted: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const newSha = (await this.git.revparse(["HEAD"])).trim();
    return newSha;
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
