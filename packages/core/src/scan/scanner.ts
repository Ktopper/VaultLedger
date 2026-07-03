import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { PermissionsManifest } from "../schemas/manifest.js";
import { BrokerError } from "../errors.js";

// NOTE: gray-matter / YAML frontmatter parsing (mentioned in design §7) is
// intentionally omitted here — no VaultProfile field is frontmatter-derived in
// v0.1 (YAGNI), so counting wikilinks on the raw text is sufficient and avoids
// per-note parse cost on a "safe to run" onboarding scan.

export interface VaultProfile {
  root: string;
  noteCount: number;
  linkCount: number;
  folders: string[];
  detected: {
    dailyNotes: boolean;
    templates: boolean;
    attachments: boolean;
    likelyProjects: string[];
  };
  hasPrivate: boolean;
  hasAgent: boolean;
}

export interface ScanResult {
  profile: VaultProfile;
  proposedManifest: PermissionsManifest;
}

const DEFAULT_EXCLUDE_DIRS = new Set([".git", ".obsidian", ".ledger", "node_modules", ".trash"]);

// Bounded quantifier ({1,300}) instead of + so a corrupt/adversarial note full
// of unterminated "[[" cannot trigger O(n^2) backtracking (ReDoS). 300 chars is
// far longer than any real wikilink incl. aliases/headings ([[Note|Alias#H]]).
const WIKILINK_RE = /\[\[[^\]\r\n]{1,300}\]\]/g;
const DAILY_FOLDER_RE = /^(daily|journal|dailies)$/i;
const DAILY_NOTE_RE = /^\d{4}-\d{2}-\d{2}/;
const TEMPLATES_FOLDER_RE = /^templates?$/i;
const ATTACHMENTS_FOLDER_RE = /^(attachments|assets|files|media|images)$/i;
const PROJECTS_FOLDER_RE = /^(projects?|areas|work)$/i;
const PRIVATE_FOLDER_RE = /^private$/i;
const AGENT_FOLDER_RE = /^agent$/i;

interface WalkStats {
  /** top-level folder name -> md note count anywhere beneath it */
  topFolderNoteCounts: Map<string, number>;
  /** immediate subdirectory names of root (excluding excluded/symlinks) */
  topLevelFolders: string[];
  /** every folder base name encountered in the tree (for hasPrivate/hasAgent) */
  allFolderNames: Set<string>;
  /** note (file) basenames, for the YYYY-MM-DD daily-note pattern */
  noteBaseNames: string[];
  noteCount: number;
  linkCount: number;
  mdFileCount: number;
  nonMdFileCount: number;
}

function walk(root: string, excludeDirs: Set<string>): WalkStats {
  const stats: WalkStats = {
    topFolderNoteCounts: new Map(),
    topLevelFolders: [],
    allFolderNames: new Set(),
    noteBaseNames: [],
    noteCount: 0,
    linkCount: 0,
    mdFileCount: 0,
    nonMdFileCount: 0,
  };

  // Single traversal. `depth` distinguishes root's immediate children (depth 0)
  // so top-level folders are captured inline — no separate readdir(root) pass,
  // no duplicated exclusion/symlink logic.
  function walkDir(dir: string, topFolder: string | null, depth: number): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      // One source of truth for symlink-skipping: the Dirent from withFileTypes
      // (lstat semantics). Never follow symlinked dirs, never count symlink files.
      if (entry.isSymbolicLink()) continue;

      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) continue;
        stats.allFolderNames.add(entry.name);
        if (depth === 0) stats.topLevelFolders.push(entry.name);
        walkDir(full, topFolder ?? entry.name, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;

      const isMd = entry.name.toLowerCase().endsWith(".md");
      if (isMd) {
        stats.mdFileCount += 1;
        stats.noteCount += 1;
        stats.noteBaseNames.push(entry.name);
        if (topFolder) {
          stats.topFolderNoteCounts.set(topFolder, (stats.topFolderNoteCounts.get(topFolder) ?? 0) + 1);
        }
        try {
          const text = readFileSync(full, "utf8");
          const matches = text.match(WIKILINK_RE);
          if (matches) stats.linkCount += matches.length;
        } catch {
          // Unreadable file (binary, EISDIR, perms): still counted as a note,
          // just contributes no links. A single bad file must not abort the scan.
        }
      } else {
        stats.nonMdFileCount += 1;
      }
    }
  }

  walkDir(root, null, 0);
  return stats;
}

export function scanVault(root: string, opts?: { excludeDirs?: string[] }): ScanResult {
  // Validate root up front so a missing path or a file is distinguishable from
  // an empty vault (an all-zero profile would silently mislead `ledger init`).
  let rootStat;
  try {
    rootStat = statSync(root);
  } catch {
    throw new BrokerError("NOT_FOUND", `vault path not found or not a directory: ${root}`);
  }
  if (!rootStat.isDirectory()) {
    throw new BrokerError("NOT_FOUND", `vault path not found or not a directory: ${root}`);
  }

  const excludeDirs = new Set(DEFAULT_EXCLUDE_DIRS);
  for (const name of opts?.excludeDirs ?? []) excludeDirs.add(name);

  const stats = walk(root, excludeDirs);

  const dailyNotes =
    stats.topLevelFolders.some((f) => DAILY_FOLDER_RE.test(f)) ||
    stats.noteBaseNames.some((n) => DAILY_NOTE_RE.test(n));

  const templates = stats.topLevelFolders.some((f) => TEMPLATES_FOLDER_RE.test(f));

  const attachments =
    stats.topLevelFolders.some((f) => ATTACHMENTS_FOLDER_RE.test(f)) ||
    stats.nonMdFileCount > stats.mdFileCount;

  const specialFolders = new Set(
    stats.topLevelFolders.filter(
      (f) => DAILY_FOLDER_RE.test(f) || TEMPLATES_FOLDER_RE.test(f) || ATTACHMENTS_FOLDER_RE.test(f),
    ),
  );

  const likelyProjects: string[] = [];
  for (const folder of stats.topLevelFolders) {
    if (specialFolders.has(folder)) continue;
    const matchesName = PROJECTS_FOLDER_RE.test(folder);
    const noteCount = stats.topFolderNoteCounts.get(folder) ?? 0;
    if (matchesName || noteCount >= 3) {
      if (!likelyProjects.includes(folder)) likelyProjects.push(folder);
    }
  }

  const hasPrivate = [...stats.allFolderNames].some((f) => PRIVATE_FOLDER_RE.test(f));
  const hasAgent = [...stats.allFolderNames].some((f) => AGENT_FOLDER_RE.test(f));

  const profile: VaultProfile = {
    root,
    noteCount: stats.noteCount,
    linkCount: stats.linkCount,
    // Sorted for deterministic, human-diffable scan output (auditability).
    folders: [...stats.topLevelFolders].sort(),
    detected: {
      dailyNotes,
      templates,
      attachments,
      likelyProjects: likelyProjects.sort(),
    },
    hasPrivate,
    hasAgent,
  };

  const excluded = [".obsidian/**"];
  if (hasPrivate) excluded.push("Private/**");

  const proposedManifest = PermissionsManifest.parse({
    mode: "assisted",
    zones: {
      trusted: ["**"],
      agent: ["Agent/**"],
      scratch: ["Agent/Scratch/**"],
      excluded,
    },
    overrides: [],
  });

  return { profile, proposedManifest };
}
