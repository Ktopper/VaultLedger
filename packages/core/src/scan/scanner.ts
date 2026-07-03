import { readdirSync, readFileSync, lstatSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { PermissionsManifest } from "../schemas/manifest.js";

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

const WIKILINK_RE = /\[\[[^\]\r\n]+\]\]/g;
const DAILY_FOLDER_RE = /^(daily|journal|dailies)$/i;
const DAILY_NOTE_RE = /^\d{4}-\d{2}-\d{2}/;
const TEMPLATES_FOLDER_RE = /^templates?$/i;
const ATTACHMENTS_FOLDER_RE = /^(attachments|assets|files|media|images)$/i;
const PROJECTS_FOLDER_RE = /^(projects?|areas|work)$/i;
const PRIVATE_FOLDER_RE = /^private$/i;
const AGENT_FOLDER_RE = /^agent$/i;

interface WalkStats {
  /** relative path (from root) -> md note count within that top-level folder */
  topFolderNoteCounts: Map<string, number>;
  /** all top-level directory names, relative to root */
  topLevelFolders: string[];
  /** all folder base names encountered anywhere in the tree (for hasPrivate/hasAgent) */
  allFolderNames: Set<string>;
  /** all note (relative) file basenames, for dailyNotes note-pattern detection */
  noteBaseNames: string[];
  noteCount: number;
  linkCount: number;
  mdFileCount: number;
  nonMdFileCount: number;
}

function isExcludedDir(name: string, excludeDirs: Set<string>): boolean {
  return excludeDirs.has(name);
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

  function walkDir(dir: string, topFolder: string | null): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);

      // Skip symlinks entirely (don't follow, don't count).
      let isSymlink = false;
      try {
        isSymlink = lstatSync(full).isSymbolicLink();
      } catch {
        continue;
      }
      if (isSymlink) continue;

      if (entry.isDirectory()) {
        if (isExcludedDir(entry.name, excludeDirs)) continue;
        stats.allFolderNames.add(entry.name);
        const nextTop = topFolder ?? entry.name;
        walkDir(full, nextTop);
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
          // Unreadable/binary file: skip counting links, but note still counted.
        }
      } else {
        stats.nonMdFileCount += 1;
      }
    }
  }

  // Compute top-level folders explicitly (immediate children of root).
  let rootEntries: Dirent[];
  try {
    rootEntries = readdirSync(root, { withFileTypes: true });
  } catch {
    rootEntries = [];
  }
  for (const entry of rootEntries) {
    if (!entry.isDirectory()) continue;
    let isSymlink = false;
    try {
      isSymlink = lstatSync(join(root, entry.name)).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink) continue;
    if (isExcludedDir(entry.name, excludeDirs)) continue;
    stats.topLevelFolders.push(entry.name);
  }

  walkDir(root, null);

  return stats;
}

export function scanVault(root: string, opts?: { excludeDirs?: string[] }): ScanResult {
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
      (f) =>
        DAILY_FOLDER_RE.test(f) ||
        TEMPLATES_FOLDER_RE.test(f) ||
        ATTACHMENTS_FOLDER_RE.test(f),
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
    folders: stats.topLevelFolders,
    detected: {
      dailyNotes,
      templates,
      attachments,
      likelyProjects,
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
