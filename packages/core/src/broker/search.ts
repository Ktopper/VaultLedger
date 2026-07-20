import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PermissionsManifest } from "../schemas/manifest.js";
import { resolveZone } from "../zones.js";
import { READ_MAX_BYTES } from "./read.js";

/** Hard cap on the total number of matches (across all files) a single search
 * returns (§WU-4). Only REAL hits count toward this cap — a skipped
 * (excluded/oversized/non-UTF-8) file never nudges it. */
export const SEARCH_MAX_MATCHES = 50;

/** Hard cap on a single snippet's length (§WU-4), centered on the match. */
export const SEARCH_SNIPPET_MAX = 200;

export interface SearchMatch {
  path: string;
  snippet: string;
  /** 1-based line number of the match within the file. */
  line: number;
}

export interface VaultSearchResult {
  matches: SearchMatch[];
  truncated: boolean;
}

/**
 * Governed, bounded, case-insensitive LITERAL search over readable vault notes.
 * Read-only: no Broker.apply, no lock, no journal, and NO index — a plain scan
 * over the readable files under the containment gate (KISS; an index is a
 * non-goal). Regex is a non-goal; `query` is matched literally.
 *
 * Zone discipline (oracle): excluded files are NEVER scanned and NEVER appear.
 * The walk skips excluded directories (so `.git`, `.ledger`, `.obsidian`, and a
 * manifest `Private/**` subtree are never descended) and excluded files. Files
 * over the 64 KiB read cap and non-UTF-8 files are SKIPPED SILENTLY. Skipping is
 * INDISTINGUISHABLE from no-match: a hit inside a skipped/oversized/excluded file
 * produces the SAME empty result as a genuine no-match — no "N skipped" signal.
 *
 * FILTER/SKIP-BEFORE-CAP (mirrors list): only REAL hits count toward
 * `SEARCH_MAX_MATCHES` and `truncated`; a skipped file never nudges either.
 *
 * The walk never follows symlinks (a symlinked entry is neither an `isDirectory`
 * nor an `isFile` dirent, so it is skipped), so every path scanned is a real file
 * with no symlink components — its lexical relative path equals its canonical
 * zone path, and the containment guarantee holds structurally.
 */
export function searchVault(
  vaultRoot: string,
  manifest: PermissionsManifest,
  query: string,
  opts?: { maxMatches?: number; maxBytes?: number; snippetMax?: number },
): VaultSearchResult {
  const maxMatches = opts?.maxMatches ?? SEARCH_MAX_MATCHES;
  const maxBytes = opts?.maxBytes ?? READ_MAX_BYTES;
  const snippetMax = opts?.snippetMax ?? SEARCH_SNIPPET_MAX;

  const matches: SearchMatch[] = [];
  let truncated = false;

  // An empty query matches every position — guard so it returns nothing rather
  // than an unbounded run of zero-length hits. (The MCP layer's min-1 schema
  // rejects it earlier; this keeps the core function safe on its own.)
  if (query.length === 0) return { matches, truncated };

  // Case-insensitive LITERAL match. Indices are taken on the lowercased content
  // and reused on the original content for the snippet — correct for the ASCII/
  // typical-markdown case (a handful of code points whose lowercase changes UTF-16
  // length could drift, but that is out of scope for v1 literal search).
  const needle = query.toLowerCase();
  const rootAbs = resolve(vaultRoot);

  const byName = (a: { name: string }, b: { name: string }) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

  const makeMatch = (rel: string, content: string, idx: number): SearchMatch => {
    let line = 1;
    for (let i = 0; i < idx; i++) if (content.charCodeAt(i) === 10) line++;

    const lineStart = content.lastIndexOf("\n", idx - 1) + 1;
    let lineEnd = content.indexOf("\n", idx);
    if (lineEnd === -1) lineEnd = content.length;
    const lineText = content.slice(lineStart, lineEnd);

    if (lineText.length <= snippetMax) {
      return { path: rel, snippet: lineText, line };
    }
    // Center a `snippetMax`-wide window on the match within its line.
    const matchInLine = idx - lineStart;
    let end = Math.min(lineText.length, matchInLine + Math.ceil(snippetMax / 2));
    const start = Math.max(0, end - snippetMax);
    end = Math.min(lineText.length, start + snippetMax);
    return { path: rel, snippet: lineText.slice(start, end), line };
  };

  const scanFile = (rel: string, abs: string): void => {
    let st;
    try {
      st = statSync(abs);
    } catch {
      return; // disappeared under us → skip (indistinguishable from no-match)
    }
    if (!st.isFile()) return;
    if (st.size > maxBytes) return; // oversized → skip silently

    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch {
      return;
    }
    const content = buf.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(buf)) return; // non-UTF-8 → skip silently

    const hay = content.toLowerCase();
    let from = 0;
    for (;;) {
      const idx = hay.indexOf(needle, from);
      if (idx === -1) break;
      if (matches.length >= maxMatches) {
        // A real hit exists beyond the cap → the result is truncated. Only real
        // hits reach this point (skipped files returned above), so a skipped file
        // can never set this flag.
        truncated = true;
        return;
      }
      matches.push(makeMatch(rel, content, idx));
      from = idx + needle.length;
    }
  };

  const walk = (relDir: string): void => {
    if (truncated) return;
    const absDir = relDir === "." ? rootAbs : join(rootAbs, relDir);
    let dirents;
    try {
      dirents = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort(byName);
    for (const d of dirents) {
      if (truncated) return;
      const rel = relDir === "." ? d.name : `${relDir}/${d.name}`;
      // Never scan or descend an excluded path. Because no symlink is ever
      // followed, `rel` is the canonical zone path.
      if (resolveZone(rel, manifest) === "excluded") continue;
      if (d.isDirectory()) {
        walk(rel);
      } else if (d.isFile()) {
        scanFile(rel, join(absDir, d.name));
      }
      // symlinks / other entry types are skipped
    }
  };

  walk(".");
  return { matches, truncated };
}
