import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import matter from "gray-matter";
import type { LedgerGit } from "../broker/git.js";
import { MESSAGE_RE } from "../broker/reconcile.js";
import type { Journal, MemoryRow, TransactionRow } from "../journal/journal.js";
import { MemoryProvenance } from "../schemas/provenance.js";

const DEFAULT_AGENT_DIRS = ["Agent/Memory", "Agent/Archive"];

export interface ReindexOptions {
  vaultRoot: string;
  git: LedgerGit;
  journal: Journal;
  /** Vault-relative dirs (or "<dir>/**" globs) to walk for memory notes.
   * Defaults to Agent/Memory + Agent/Archive. A trailing "/**" or "/*" is
   * stripped so a manifest glob like "Agent/**" can be passed directly. */
  agentGlobs?: string[];
  now: () => string;
  genId: (prefix: string) => string;
}

export interface ReindexResult {
  /** Memory notes with valid `ledger:` provenance upserted this run. */
  memories: number;
  /** NEW transaction rows inserted this run (commits already in the journal are skipped). */
  transactions: number;
}

function globToDir(glob: string): string {
  return glob.replace(/\/\*\*?$/, "");
}

/** Recursively collect absolute paths of every .md file under `absDir` (which may not exist). */
function walkMarkdownFiles(absDir: string): string[] {
  if (!existsSync(absDir)) return [];
  const out: string[] = [];
  const stack: string[] = [absDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(abs);
      }
    }
  }
  return out;
}

/**
 * Upsert one memory row (+ tags) from a note's `ledger:` frontmatter block.
 * Returns true if the file had a valid ledger block (and was therefore
 * counted), false if it was skipped (no `ledger.id`, e.g. a non-memory note
 * that happens to live under the walked directories).
 */
function upsertFromFile(journal: Journal, vaultRoot: string, absPath: string): boolean {
  const raw = readFileSync(absPath, "utf8");
  const parsed = matter(raw);
  const ledgerData = (parsed.data as Record<string, unknown>).ledger;
  if (!ledgerData || typeof ledgerData !== "object" || !("id" in ledgerData)) {
    return false;
  }

  const provenance = MemoryProvenance.parse(ledgerData);
  const relPath = relative(vaultRoot, absPath).split(sep).join("/");
  const rawEntity = (parsed.data as Record<string, unknown>).entity;
  const entity = typeof rawEntity === "string" ? rawEntity : null;
  const rawTags = (parsed.data as Record<string, unknown>).tags;
  const tags = Array.isArray(rawTags) ? rawTags.map((t) => String(t)) : [];

  const patch: Partial<Omit<MemoryRow, "id">> = {
    path: relPath,
    entity,
    status: provenance.status,
    confidence: provenance.confidence,
    created: provenance.created,
    source: provenance.source,
    supersedes: provenance.supersedes,
    expires: provenance.expires,
  };

  const existing = journal.getMemory(provenance.id);
  if (existing) {
    journal.updateMemory(provenance.id, patch);
  } else {
    const row: MemoryRow = { id: provenance.id, ...patch, last_referenced: null } as MemoryRow;
    journal.insertMemory(row);
  }

  // Idempotency guard: only (re-)add tags the first time this memory has
  // none recorded yet, so re-running reindex against the same files never
  // duplicates memory_tags rows (Journal has no removeTags primitive).
  if (tags.length > 0 && journal.getTags(provenance.id).length === 0) {
    journal.addTags(provenance.id, tags);
  }

  return true;
}

/**
 * Rebuild the journal's `memories` and `transactions` tables from the vault
 * on disk + the git history (design §3.3, disaster recovery). Memories are
 * recovered by walking the agent zone for notes carrying a `ledger:`
 * frontmatter block; transactions are recovered by replaying every ledger
 * commit not already present in the journal (same message parser as
 * `reconcile`, just tagged `reason: "reindexed"` instead of "reconciled from
 * commit" so the provenance of the repair is distinguishable).
 */
export async function reindex(opts: ReindexOptions): Promise<ReindexResult> {
  const { vaultRoot, git, journal, now, genId } = opts;
  const dirs = opts.agentGlobs && opts.agentGlobs.length > 0
    ? opts.agentGlobs.map(globToDir)
    : DEFAULT_AGENT_DIRS;

  let memories = 0;
  for (const dir of dirs) {
    for (const absPath of walkMarkdownFiles(join(vaultRoot, dir))) {
      if (upsertFromFile(journal, vaultRoot, absPath)) {
        memories += 1;
      }
    }
  }

  const commits = await git.listLedgerCommits();
  let transactions = 0;
  for (const { sha, message } of commits) {
    if (journal.hasCommit(sha)) continue;

    const match = MESSAGE_RE.exec(message);
    if (!match) continue;

    const op = match[1]!;
    const basename = match[2]!;
    const memoryId = match[3];
    const session = match[4]!;

    const row: TransactionRow = {
      id: genId("txn"),
      op,
      path: basename,
      hash_before: null,
      hash_after: null,
      session,
      reason: "reindexed",
      memory_id: memoryId ?? null,
      commit_sha: sha,
      created_at: now(),
      status: "applied",
    };
    journal.recordTransaction(row);
    transactions += 1;
  }

  return { memories, transactions };
}

export interface EnsureJournalOptions {
  vaultRoot: string;
  git: LedgerGit;
  journal: Journal;
  agentGlobs?: string[];
  now: () => string;
  genId: (prefix: string) => string;
}

/**
 * Auto-heal (design §3.3): if the journal is completely empty (no memories,
 * no transactions — e.g. a fresh app-support dir pointed at an existing
 * vault, or a wiped journal.db), run `reindex` to rebuild it from disk + git
 * and report `true`. A journal with ANY existing data is left untouched
 * (returns `false`) — auto-heal only fires for the "nothing here yet" case,
 * never as a background merge against a partially-populated journal.
 */
export async function ensureJournal(opts: EnsureJournalOptions): Promise<boolean> {
  const { journal } = opts;
  const hasMemories = journal.queryMemories({ limit: 1 }).length > 0;
  const hasTransactions = journal.listTransactions({ limit: 1 }).length > 0;
  if (hasMemories || hasTransactions) return false;

  await reindex(opts);
  return true;
}
