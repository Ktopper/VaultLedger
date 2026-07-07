# Undertow → VaultLedger Integration Decision

**Date:** 2026-07-03
**Status:** Accepted
**Context:** Undertow-assist is a separate Python project (Obsidian-backed
remember/recall/distill/retire with a tamper-evident SQLite decision ledger).
Question: integrate as a client, merge, or run side by side?

## Decision

**Merge concepts, not code.** Undertow's lifecycle ideas are reimplemented
natively in VaultLedger core (TypeScript) in v0.3. Undertow-assist as a running
Python system is not integrated: its direct filesystem writes bypass the broker,
and any bypass path makes VaultLedger advisory rather than an enforcement layer
— the exact failure mode the product exists to prevent. Side-by-side operation
is rejected for the same reason.

## Adopted (v0.3 unless noted)

| Undertow concept | VaultLedger form |
|---|---|
| `distill` / DISTILL event | `memory_distill` op: derived memory with `derivation: {kind: distilled, sources: [...]}` provenance + `memory_relations` table |
| `retire` / PRUNE event | `memory_retire` op: structured metadata patch (status flip, `retired_reason`, `superseded_by`) — never appended prose; distinct from `forget` |
| Evidence-drift auditing | Source-linked staleness: retiring/revising a source flags every distillation citing it; surfaced in audit queue |
| Memory-health reports | Folded into existing v0.3 conflict/staleness queues + `ledger memory audit`; no separate reporting subsystem |
| Confidence score | Optional numeric score recorded as evidence alongside the authoritative enum; never gates lifecycle transitions |
| Replay / regret analysis | Deferred to "Later" milestone — needs a stable lifecycle to analyze |

## Rejected

- **Hash-chain tamper-evident ledger.** Git is VaultLedger's tamper evidence;
  the SQLite journal is deliberately a disposable, rebuildable index. A second
  authoritative ledger reintroduces the two-sources-of-truth problem the v0.1
  design explicitly removed (journal rebuildable from vault + Git).
- **Second decision ledger / dual journals.** One journal. Epistemic context
  (reason, confidence, sources) lives in provenance frontmatter and transaction
  rows, not a parallel database.
- **`POST /emit` HTTP endpoint.** MCP is the agent interface; localhost HTTP
  arrives with `ledger serve` for the plugin only.
- **Undertow frontmatter schema (`undertow_*` fields).** The existing `ledger:`
  block is extended with `derivation` (and optional score); no parallel envelope.
- **Direct-write client mode.** No backend where Undertow (or anything) writes
  vault files itself.

## Sequencing

1. **Blockers first:** the three v0.1 security fixes (`.ledger/**`
   always-excluded in `resolveZone`, case-fold zone matching, realpath
   containment) — build-prompts Prompt 8.5.
2. v0.2 Obsidian plugin as planned.
3. v0.3 becomes "lifecycle + audit": Prompt 10 (contradictions) + Prompt 10.5
   (distill/retire/source relations/staleness links).

## Consequences

- VaultLedger's scope statement widens from "governed write broker" toward
  "governed memory system," but only where lifecycle must be broker-enforced
  anyway. Retrieval intelligence and regret analysis remain out of core.
- Spec bumped to v1.1 (lifecycle §5.2, tool table §7, milestones §8).
