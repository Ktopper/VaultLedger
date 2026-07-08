import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Journal } from "../journal/journal.js";
import type { ContradictionDetector } from "./detector.js";
import { HeuristicDetector } from "./detector.js";
import type { EntityMatcher } from "./matcher.js";
import { DefaultEntityMatcher } from "./matcher.js";
import { conflictValueHash } from "./valueHash.js";

export interface CheckContradictionsDeps {
  journal: Journal;
  vaultRoot: string;
  now: () => string;
  genId: (prefix: string) => string;
  matcher?: EntityMatcher;
  detector?: ContradictionDetector;
}

/**
 * Post-commit contradiction check (design v0.3a phase 5). Called AFTER a
 * memory write has already landed (broker + journal committed) — this is a
 * best-effort, read-only side check, not part of the write's transaction:
 * it takes NO vault lock (journal + file reads only) and NEVER throws. Any
 * failure (unreadable file, bad journal state, detector bug) is logged and
 * swallowed so a contradiction-detection bug can never block or fail a
 * remember/revise.
 */
export function checkContradictions(deps: CheckContradictionsDeps, memId: string): void {
  try {
    const { journal, vaultRoot, now, genId } = deps;
    const mem = journal.getMemory(memId);
    if (!mem) return;

    const matcher = deps.matcher ?? new DefaultEntityMatcher();
    const detector = deps.detector ?? new HeuristicDetector();

    const peers = matcher.comparisonSet(mem, journal);
    if (peers.length === 0) return;

    const memText = readFileSync(join(vaultRoot, mem.path), "utf8");

    for (const peer of peers) {
      let peerText: string;
      try {
        peerText = readFileSync(join(vaultRoot, peer.path), "utf8");
      } catch (err) {
        // Unreadable peer file: skip just this peer, keep checking the rest.
        console.error(`checkContradictions: could not read peer ${peer.id} (${peer.path}):`, err);
        continue;
      }

      // Run detection in id-sorted (memory_a=lo, memory_b=hi) order so the
      // detector's "a-value vs b-value" `detail` string attributes each value to
      // the SAME side the stored memory_a/memory_b ids do. Detecting in raw
      // mem-vs-peer order would mislabel the values whenever mem.id sorts after
      // peer.id, so a human could forget the wrong memory.
      const memIsLo = mem.id < peer.id;
      const lo = memIsLo ? mem.id : peer.id;
      const hi = memIsLo ? peer.id : mem.id;
      const loText = memIsLo ? memText : peerText;
      const hiText = memIsLo ? peerText : memText;

      const found = detector.detect({ text: loText }, { text: hiText });
      for (const conflict of found) {
        journal.insertConflict({
          id: genId("cf"),
          memory_a: lo,
          memory_b: hi,
          pair_lo: lo,
          pair_hi: hi,
          kind: conflict.kind,
          fact_key: conflict.factKey,
          value_hash: conflictValueHash(conflict.kind, conflict.values[0], conflict.values[1]),
          entity: mem.entity,
          detail: conflict.detail,
          created_at: now(),
          state: "open",
          resolved_at: null,
        });
      }
    }
  } catch (err) {
    // Non-blocking (design §4.1): a contradiction-check failure must never
    // surface to the caller of remember/revise/forget/undo.
    console.error("checkContradictions failed:", err);
  }
}
