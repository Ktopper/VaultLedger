import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { PermissionsManifest } from "../schemas/manifest.js";
import { BrokerError } from "../errors.js";
import { resolveZone } from "../zones.js";

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
  /**
   * root-relative, forward-slash-joined path of every folder whose base name
   * matches PRIVATE_FOLDER_RE, at ANY depth (e.g. "Agent/Memory/Private").
   * Used post-scan to self-check the proposed manifest actually excludes
   * each one (VL-SEC-S7-03) -- hasPrivate alone only tells you a Private
   * folder exists somewhere, not that the proposed excluded globs cover
   * where it actually lives.
   */
  privateFolderPaths: string[];
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
    privateFolderPaths: [],
    noteBaseNames: [],
    noteCount: 0,
    linkCount: 0,
    mdFileCount: 0,
    nonMdFileCount: 0,
  };

  // Single traversal. `depth` distinguishes root's immediate children (depth 0)
  // so top-level folders are captured inline — no separate readdir(root) pass,
  // no duplicated exclusion/symlink logic. `relPath` is the root-relative,
  // forward-slash-joined path of `dir` itself ("" at the root), tracked
  // alongside `topFolder` so a Private folder found at any depth can be
  // recorded with its FULL path (not just its base name) for the
  // post-scan exclusion self-check.
  function walkDir(dir: string, topFolder: string | null, depth: number, relPath: string): void {
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
      const entryRelPath = relPath ? `${relPath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) continue;
        stats.allFolderNames.add(entry.name);
        if (PRIVATE_FOLDER_RE.test(entry.name)) stats.privateFolderPaths.push(entryRelPath);
        if (depth === 0) stats.topLevelFolders.push(entry.name);
        walkDir(full, topFolder ?? entry.name, depth + 1, entryRelPath);
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

  walkDir(root, null, 0, "");
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
  // Unanchored glob (VL-SEC-S7-03 fix): hasPrivate is detected at ANY depth
  // ([...allFolderNames].some(...) above scans the whole tree), so the
  // exclusion glob must match Private at any depth too — a root-anchored
  // "Private/**" only shields a vault-root Private folder, silently leaving
  // e.g. "Agent/Memory/Private/" or "Projects/ClientX/Private/" in-zone even
  // though the manifest reports hasPrivate:true. picomatch's "**/Private/**"
  // (with the shared PICOMATCH_OPTS { dot: true, nocase: true } used by
  // resolveZone) matches BOTH a root "Private/x.md" and any nested
  // ".../Private/x.md", and case-insensitively — verified in
  // packages/core/test/scan/scanner.test.ts.
  if (hasPrivate) excluded.push("**/Private/**");

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

  // Self-check invariant (VL-SEC-S7-03 fix, part 2): before handing this
  // manifest back to `ledger init`/`setup` to print and (on confirm) write,
  // verify EVERY folder matching PRIVATE_FOLDER_RE anywhere in the scanned
  // tree actually resolves to "excluded" under the manifest we just built.
  // This is deliberately redundant with the glob fix above — it's a
  // defense-in-depth backstop so a future regression (e.g. someone
  // re-anchoring the glob, or adding a competing base-zone/override glob
  // that outranks it) is caught here, at the source, rather than silently
  // shipping an under-exclusion like the one this fixes.
  for (const folderPath of stats.privateFolderPaths) {
    const probe = `${folderPath}/__vaultledger_invariant_probe__.md`;
    if (resolveZone(probe, proposedManifest) !== "excluded") {
      throw new BrokerError(
        "INVARIANT_VIOLATION",
        `scanVault refused to propose an unsafe manifest: folder "${folderPath}" matches the ` +
          `Private-folder pattern but does not resolve to the excluded zone under the proposed ` +
          `excluded globs (${JSON.stringify(excluded)}). This would silently under-protect a ` +
          `folder the human expects to be excluded.`,
      );
    }
  }

  return { profile, proposedManifest };
}

/**
 * Read-only walk collecting every directory whose basename matches
 * PRIVATE_FOLDER_RE, at any depth, as vault-root-relative forward-slash paths.
 * Skips the same DEFAULT_EXCLUDE_DIRS `scanVault` skips. Used by `ledger
 * doctor`'s zone-integrity check to probe each against the CURRENT manifest
 * (scanVault's internal walk probes the proposed one and would throw).
 */
export function findPrivateFolders(root: string): string[] {
  const out: string[] = [];
  const walk = (absDir: string, relDir: string): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (DEFAULT_EXCLUDE_DIRS.has(entry.name)) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (PRIVATE_FOLDER_RE.test(entry.name)) out.push(rel);
      walk(join(absDir, entry.name), rel);
    }
  };
  walk(root, "");
  return out;
}
