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
  /** Vault-relative paths of notes that could NOT be parsed (bad YAML or a
   * `ledger:` block that fails provenance validation). A single corrupt note
   * must not abort disaster recovery — it is skipped and recorded here. */
  skipped: string[];
  /** Vault-relative paths of notes carrying a `ledger.id` already claimed by an
   * earlier-walked note. The FIRST occurrence wins; later duplicates are not
   * upserted (they'd silently clobber the winner) and are recorded here. */
  conflicts: string[];
  /**
   * Vault-relative paths of notes whose file declares `ledger.status:
   * canonical` while the PRE-EXISTING journal row for that same id was some
   * other (non-canonical) status -- i.e. an elevation to canonical that
   * happened out-of-band, outside the broker's approval-gated promote/
   * setStatus path (design: belt-and-braces recovery tripwire).
   *
   * This is a FLAG, never a refusal: reindex always adopts the file's
   * status regardless (the journal is disposable and MUST fully rebuild
   * from the vault, per design). A fresh full rebuild (no prior row for
   * this id) is never flagged here -- there is nothing to compare against,
   * so flagging would be pure noise on every legitimate canonical note.
   */
  elevatedToCanonical: string[];
}

interface ParsedMemoryNote {
  id: string;
  entity: string | null;
  tags: string[];
  /** Source memory ids this note was distilled from (from
   * `ledger.derivation.sources`), or [] if the note carries no derivation
   * block — most notes. */
  derivationSources: string[];
  patch: Partial<Omit<MemoryRow, "id">>;
}

function globToDir(glob: string): string {
  return glob.replace(/\/\*\*?$/, "");
}

/** Recursively collect absolute paths of every .md file under `absDir` (which
 * may not exist), sorted lexicographically so the walk order — and therefore
 * which file "wins" a duplicate-id conflict — is deterministic. */
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
  return out.sort();
}

/**
 * Parse a note's `ledger:` provenance into a memory-row patch. Returns null if
 * the file has no `ledger.id` (a non-memory note that merely lives under the
 * walked dirs — not an error). THROWS if the frontmatter is unparseable or the
 * `ledger:` block fails provenance validation — the caller catches that and
 * records the file in `skipped`.
 */
function parseMemoryNote(vaultRoot: string, absPath: string): ParsedMemoryNote | null {
  const raw = readFileSync(absPath, "utf8");
  const parsed = matter(raw);
  const ledgerData = (parsed.data as Record<string, unknown>).ledger;
  if (!ledgerData || typeof ledgerData !== "object" || !("id" in ledgerData)) {
    return null;
  }

  const provenance = MemoryProvenance.parse(ledgerData);
  const relPath = relative(vaultRoot, absPath).split(sep).join("/");
  const rawEntity = (parsed.data as Record<string, unknown>).entity;
  const entity = typeof rawEntity === "string" ? rawEntity : null;
  const rawTags = (parsed.data as Record<string, unknown>).tags;
  const tags = Array.isArray(rawTags) ? rawTags.map((t) => String(t)) : [];

  const derivationSources = provenance.derivation?.sources ?? [];

  return {
    id: provenance.id,
    entity,
    tags,
    derivationSources,
    patch: {
      path: relPath,
      entity,
      status: provenance.status,
      confidence: provenance.confidence,
      created: provenance.created,
      source: provenance.source,
      supersedes: provenance.supersedes,
      expires: provenance.expires,
    },
  };
}

/**
 * Upsert a parsed memory row (+ tags) into the journal. Returns true iff this
 * upsert is an out-of-band elevation to canonical: a journal row already
 * existed (this is an INCREMENTAL reindex, not a fresh rebuild) with some
 * other status, and the file now declares canonical. Only that one direction
 * is flagged -- a fresh insert (no prior row) or a row that was already
 * canonical are both left alone (see ReindexResult.elevatedToCanonical).
 */
function upsertMemory(journal: Journal, note: ParsedMemoryNote): boolean {
  const existing = journal.getMemory(note.id);
  const elevatedToCanonical =
    existing !== null && existing.status !== "canonical" && note.patch.status === "canonical";

  // Entity-durability fallback: a "legacy" note whose file predates
  // entity-in-frontmatter parses with entity=null, but the journal row may
  // still hold the real entity. On an INCREMENTAL reindex, preserve it rather
  // than nulling it -- a routine reindex must not silently empty a memory's
  // same-entity comparison set. (A fresh rebuild from an empty journal has no
  // prior row to fall back on; notes written after the remember() fix carry
  // entity in the file and recover cleanly. See design §9.)
  const patch =
    note.patch.entity == null && existing?.entity != null
      ? { ...note.patch, entity: existing.entity }
      : note.patch;

  if (existing) {
    journal.updateMemory(note.id, patch);
  } else {
    const row: MemoryRow = { id: note.id, ...patch, last_referenced: null } as MemoryRow;
    journal.insertMemory(row);
  }

  // Idempotency guard: only (re-)add tags the first time this memory has
  // none recorded yet, so re-running reindex against the same files never
  // duplicates memory_tags rows (Journal has no removeTags primitive).
  if (note.tags.length > 0 && journal.getTags(note.id).length === 0) {
    journal.addTags(note.id, note.tags);
  }

  // Rebuild this memory's memory_relations edges from the file's
  // `ledger.derivation.sources` every pass: clear-then-insert (unlike tags,
  // Journal DOES have deleteRelationsForMemory) so the edge set always
  // matches the file exactly -- including a source list that shrinks or
  // changes between reindex runs -- while insertRelation's own
  // ON CONFLICT DO NOTHING keeps a single pass over an unchanged source list
  // from ever producing a duplicate row.
  if (note.derivationSources.length > 0) {
    journal.deleteRelationsForMemory(note.id);
    for (const sourceId of note.derivationSources) {
      journal.insertRelation({ memory_id: note.id, source_id: sourceId, kind: "distilled" });
    }
  }

  return elevatedToCanonical;
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
  const skipped: string[] = [];
  const conflicts: string[] = [];
  const elevatedToCanonical: string[] = [];
  const seenIds = new Set<string>();
  for (const dir of dirs) {
    for (const absPath of walkMarkdownFiles(join(vaultRoot, dir))) {
      const relPath = relative(vaultRoot, absPath).split(sep).join("/");
      let note: ParsedMemoryNote | null;
      try {
        note = parseMemoryNote(vaultRoot, absPath);
      } catch {
        // Bad YAML or a ledger block that fails provenance validation: skip
        // this one note and keep going — one corrupt file must not abort the
        // whole rebuild.
        skipped.push(relPath);
        continue;
      }
      if (!note) continue; // not a memory note (no ledger.id) — silently ignore
      if (seenIds.has(note.id)) {
        // A later note re-using an already-seen id: keep the first, record the
        // collision rather than letting the last writer silently win.
        conflicts.push(relPath);
        continue;
      }
      seenIds.add(note.id);
      const elevated = upsertMemory(journal, note);
      if (elevated) elevatedToCanonical.push(relPath);
      memories += 1;
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
      approval_id: null,
      created_at: now(),
      status: "applied",
    };
    // recordTransactionIfNew (not recordTransaction): two processes can race
    // to reindex the same missing commit; ON CONFLICT(commit_sha) DO NOTHING
    // converges them on one row instead of the loser crashing.
    if (journal.recordTransactionIfNew(row)) {
      transactions += 1;
    }
  }

  return { memories, transactions, skipped, conflicts, elevatedToCanonical };
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
  // v0.1: this is a check-then-act with no lock. Two processes starting against
  // the same brand-new journal could both see it empty and both run reindex.
  // reindex's upserts are idempotent (same ids, hasCommit-guarded transactions)
  // so a double run is harmless beyond wasted work — acceptable for v0.1.
  const hasMemories = journal.queryMemories({ limit: 1 }).length > 0;
  const hasTransactions = journal.listTransactions({ limit: 1 }).length > 0;
  if (hasMemories || hasTransactions) return false;

  await reindex(opts);
  return true;
}
