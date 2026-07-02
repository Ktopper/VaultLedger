# VaultLedger v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the v0.1 governed-write loop — a deterministic broker that every agent write to a vault must pass through, with provenance, approval, Git-backed rollback, and a journal-indexed recall, exposed over MCP and a CLI.

**Architecture:** A single `core` package holds all business logic (zone resolution, the broker pipeline, the SQLite journal, memory lifecycle, scanner, undo/reindex). `cli` and `mcp-server` are thin adapters that validate input with `core`'s zod schemas and call `core` APIs. The vault + Git are the source of truth; the SQLite journal is a disposable, rebuildable index. `obsidian-plugin` is a compile-only stub this milestone.

**Tech Stack:** TypeScript (strict, ESM, project references), pnpm workspaces, vitest, zod, better-sqlite3, simple-git, picomatch, gray-matter, `diff`, commander, `@modelcontextprotocol/sdk`.

**Reference:** Design spec at `docs/superpowers/specs/2026-07-02-vaultledger-v01-design.md`. Read it before starting; section numbers below (§N) refer to it.

**Applies throughout:** REQUIRED SUB-SKILL for every implementation task: superpowers:test-driven-development. Never write implementation before a failing test. Commit after each green test.

---

## File Structure

```
vaultledger/
├── pnpm-workspace.yaml
├── package.json                      # root scripts: build, test, lint, typecheck
├── tsconfig.base.json                # strict, ESM, composite
├── eslint.config.js
├── vitest.workspace.ts
├── CLAUDE.md
└── packages/
    ├── core/
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── src/
    │   │   ├── index.ts              # public API barrel
    │   │   ├── errors.ts             # RejectionCode enum + BrokerError
    │   │   ├── schemas/
    │   │   │   ├── operation.ts      # ProposedOperation discriminated union
    │   │   │   ├── provenance.ts     # MemoryProvenance frontmatter
    │   │   │   └── manifest.ts       # PermissionsManifest
    │   │   ├── zones.ts              # resolveZone(path, manifest)
    │   │   ├── config.ts             # .ledger/config.json + app-support path resolution
    │   │   ├── journal/
    │   │   │   ├── db.ts             # better-sqlite3 open + schema/migrations
    │   │   │   └── journal.ts        # record/query transactions, memories, tags, approvals
    │   │   ├── broker/
    │   │   │   ├── hash.ts           # sha256 of file bytes
    │   │   │   ├── patch.ts          # parse + apply unified diff, size guard
    │   │   │   ├── lint.ts           # markdown structure preservation check
    │   │   │   ├── git.ts            # simple-git wrapper (commit/revert/identity)
    │   │   │   ├── broker.ts         # pipeline orchestration (create/revise/forget)
    │   │   │   ├── undo.ts           # undoTransaction / undoSession
    │   │   │   └── reconcile.ts      # startup crash-gap reconcile
    │   │   ├── memory/
    │   │   │   ├── store.ts          # remember/revise/promote/forget
    │   │   │   ├── ttl.ts            # TTL sweep + staleness flags
    │   │   │   └── reindex.ts        # rebuild journal from vault + Git
    │   │   ├── approvals/
    │   │   │   └── queue.ts          # list/approve/reject
    │   │   ├── recall/
    │   │   │   └── recall.ts         # journal-indexed query
    │   │   └── scan/
    │   │       └── scanner.ts        # read-only vault scan → VaultProfile + manifest
    │   └── test/                     # mirrors src/
    ├── mcp-server/
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── src/
    │   │   ├── index.ts              # stdio entrypoint
    │   │   └── tools.ts              # 7 MCP tool definitions → core
    │   ├── examples/mcp.json
    │   └── test/
    ├── cli/
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── src/
    │   │   ├── index.ts              # commander program
    │   │   └── commands/             # init, status, approve, undo, log, reindex
    │   └── test/
    └── obsidian-plugin/             # STUB ONLY
        ├── package.json
        ├── tsconfig.json
        └── src/index.ts             # placeholder + one test
```

---

## Phase 0 — Monorepo scaffold (Build Prompt 1)

**Goal:** Compiling package skeletons with one placeholder test each. No business logic.

### Task 0.1: Root workspace + tooling

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `eslint.config.js`, `vitest.workspace.ts`, `.npmrc`, `CLAUDE.md`

- [ ] **Step 1: Enable pnpm**

Run: `corepack enable pnpm && pnpm -v`
Expected: prints a pnpm version (e.g. `9.x`).

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 3: Create root `package.json`**

```json
{
  "name": "vaultledger",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc --build",
    "typecheck": "tsc --build --dry --force || tsc -b",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint ."
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "eslint": "^9.10.0",
    "typescript-eslint": "^8.8.0",
    "@types/node": "^22.5.0"
  }
}
```

- [ ] **Step 4: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true
  }
}
```

- [ ] **Step 5: Create `eslint.config.js`, `.npmrc`, `vitest.workspace.ts`**

`.npmrc`:
```
auto-install-peers=true
```
`vitest.workspace.ts`:
```ts
export default ["packages/*"];
```
`eslint.config.js`:
```js
import tseslint from "typescript-eslint";
export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**"] },
  ...tseslint.configs.recommended,
);
```

- [ ] **Step 6: Create `CLAUDE.md`** with the standing instructions (spec §11):

```markdown
# VaultLedger — standing instructions

- The model never writes vault files directly; all mutations go through the broker.
- Patch-level edits only; whole-file rewrites are a broker rejection.
- Every mutation must be attributable: session, reason, commit.
- `.ledger/` is the only in-vault footprint besides the agent zone.
- When in doubt between convenience and auditability, choose auditability.
- Vault + Git are the source of truth; the SQLite journal is a disposable index.
```

- [ ] **Step 7: Commit**

```bash
git add pnpm-workspace.yaml package.json tsconfig.base.json eslint.config.js vitest.workspace.ts .npmrc CLAUDE.md
git commit -m "chore: monorepo tooling scaffold"
```

### Task 0.2: Package skeletons (core, cli, mcp-server, obsidian-plugin)

For each package, create `package.json`, `tsconfig.json` (extends base, references as needed), `src/index.ts` (placeholder export), and `test/placeholder.test.ts`.

- [ ] **Step 1: `packages/core` skeleton**

`packages/core/package.json`:
```json
{
  "name": "@vaultledger/core",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc -b" },
  "dependencies": {
    "zod": "^3.23.0",
    "better-sqlite3": "^11.3.0",
    "simple-git": "^3.27.0",
    "picomatch": "^4.0.0",
    "gray-matter": "^4.0.3",
    "diff": "^7.0.0",
    "yaml": "^2.5.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/picomatch": "^3.0.0",
    "@types/diff": "^6.0.0"
  }
}
```
`packages/core/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*"]
}
```
`packages/core/src/index.ts`:
```ts
export const VERSION = "0.1.0";
```
`packages/core/test/placeholder.test.ts`:
```ts
import { expect, test } from "vitest";
import { VERSION } from "../src/index.js";
test("core exposes version", () => { expect(VERSION).toBe("0.1.0"); });
```

- [ ] **Step 2: `packages/cli` skeleton** — same shape; `package.json` adds `"commander": "^12.1.0"`, `"@vaultledger/core": "workspace:*"`, `"diff": "^7.0.0"`, and a `"bin": { "ledger": "./dist/index.js" }`. tsconfig `references` core. Placeholder test asserts a `run` stub returns 0.

- [ ] **Step 3: `packages/mcp-server` skeleton** — `package.json` adds `"@modelcontextprotocol/sdk": "^1.0.0"`, `"@vaultledger/core": "workspace:*"`, `"zod": "^3.23.0"`, `"bin": { "vaultledger-mcp": "./dist/index.js" }`. Placeholder test asserts a `listToolNames()` stub returns the 7 tool names.

- [ ] **Step 4: `packages/obsidian-plugin` STUB** — `src/index.ts` exports `export const STUB = true;`. Placeholder test asserts it. No Obsidian API deps yet. Add a `README.md` noting "v0.2 — stub only."

- [ ] **Step 5: Install, build, test**

Run: `pnpm install && pnpm build && pnpm test`
Expected: all placeholder tests PASS; `tsc -b` produces `dist/` in each package.

- [ ] **Step 6: Commit**

```bash
git add packages/ pnpm-lock.yaml
git commit -m "chore: package skeletons with placeholder tests"
```

---

## Phase 1 — Schemas, permissions & zone resolution (Build Prompt 2)

**Goal:** zod schemas for operations/provenance/manifest, and `resolveZone` with full overlap coverage (§4).

### Task 1.1: MemoryProvenance schema

**Files:**
- Create: `packages/core/src/schemas/provenance.ts`
- Test: `packages/core/test/schemas/provenance.test.ts`

- [ ] **Step 1: Write failing test** — valid frontmatter parses; `supersedes`/`expires` accept null; bad `confidence` rejects; bad `status` rejects.

```ts
import { expect, test } from "vitest";
import { MemoryProvenance } from "../../src/schemas/provenance.js";

test("parses a full provenance block", () => {
  const p = MemoryProvenance.parse({
    id: "mem_8f3a", status: "working", created: "2026-07-02T10:45:00Z",
    source: "claude-code/session-a", reason: "deadline moved",
    confidence: "high", supersedes: "mem_71bc", expires: null,
  });
  expect(p.status).toBe("working");
});
test("rejects bad status", () => {
  expect(() => MemoryProvenance.parse({ id: "x", status: "bogus" })).toThrow();
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing). `pnpm -C packages/core test provenance`
- [ ] **Step 3: Implement**

```ts
import { z } from "zod";
export const MemoryStatus = z.enum([
  "scratch", "working", "canonical", "forgotten", "reverted",
]);
export const Confidence = z.enum(["low", "medium", "high"]);
export const MemoryProvenance = z.object({
  id: z.string().min(1),
  status: MemoryStatus,
  created: z.string().datetime(),
  source: z.string().min(1),
  reason: z.string().default(""),
  confidence: Confidence.default("medium"),
  supersedes: z.string().nullable().default(null),
  expires: z.string().datetime().nullable().default(null),
});
export type MemoryProvenance = z.infer<typeof MemoryProvenance>;
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** `feat(core): MemoryProvenance schema`

### Task 1.2: ProposedOperation discriminated union

**Files:**
- Create: `packages/core/src/schemas/operation.ts`
- Test: `packages/core/test/schemas/operation.test.ts`

Design (§4.1): discriminated union on `op`. `create` requires `content`, forbids `expected_hash`/`patch`. `revise`/`propose_edit` require `expected_hash` + `patch`. `promote` requires `id` + `target_status`. `forget` requires `id`.

- [ ] **Step 1: Write failing tests**

```ts
import { expect, test } from "vitest";
import { ProposedOperation } from "../../src/schemas/operation.js";

test("create requires content and forbids expected_hash", () => {
  expect(ProposedOperation.parse({
    op: "create", path: "Agent/Memory/x.md", content: "# x",
    reason: "r", session: "s",
  }).op).toBe("create");
  expect(() => ProposedOperation.parse({
    op: "create", path: "x.md", content: "y", reason: "r", session: "s",
    expected_hash: "sha256:abc",
  })).toThrow();
});
test("revise requires expected_hash and patch", () => {
  expect(() => ProposedOperation.parse({
    op: "revise", path: "x.md", reason: "r", session: "s",
  })).toThrow();
});
test("promote requires target_status", () => {
  expect(ProposedOperation.parse({
    op: "promote", id: "mem_1", target_status: "working", reason: "r", session: "s",
  }).op).toBe("promote");
});
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement**

```ts
import { z } from "zod";
import { MemoryStatus } from "./provenance.js";

const base = { reason: z.string().min(1), session: z.string().min(1) };

export const CreateOp = z.object({
  op: z.literal("create"),
  path: z.string().min(1),
  content: z.string(),
  entity: z.string().optional(),
  tags: z.array(z.string()).optional(),
  expected_hash: z.undefined().optional(),
  patch: z.undefined().optional(),
  ...base,
});
export const ReviseOp = z.object({
  op: z.literal("revise"),
  path: z.string().min(1),
  expected_hash: z.string().min(1),
  patch: z.string().min(1),
  entity: z.string().optional(),
  ...base,
});
export const ProposeEditOp = ReviseOp.extend({ op: z.literal("propose_edit") });
export const PromoteOp = z.object({
  op: z.literal("promote"),
  id: z.string().min(1),
  target_status: MemoryStatus,
  ...base,
});
export const ForgetOp = z.object({
  op: z.literal("forget"),
  id: z.string().min(1),
  ...base,
});
export const ProposedOperation = z.discriminatedUnion("op", [
  CreateOp, ReviseOp, ProposeEditOp, PromoteOp, ForgetOp,
]);
export type ProposedOperation = z.infer<typeof ProposedOperation>;
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** `feat(core): ProposedOperation discriminated union`

### Task 1.3: PermissionsManifest schema

**Files:**
- Create: `packages/core/src/schemas/manifest.ts`
- Test: `packages/core/test/schemas/manifest.test.ts`

- [ ] **Step 1: Failing test** — parses zones as glob lists, mode enum defaults `assisted`, per-folder overrides optional.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement**

```ts
import { z } from "zod";
export const Mode = z.enum(["safe", "assisted", "autonomous"]);
export const ZoneName = z.enum(["trusted", "agent", "scratch", "excluded"]);
export const PermissionsManifest = z.object({
  version: z.literal(1).default(1),
  mode: Mode.default("assisted"),
  zones: z.object({
    trusted: z.array(z.string()).default([]),
    agent: z.array(z.string()).default([]),
    scratch: z.array(z.string()).default([]),
    excluded: z.array(z.string()).default([]),
  }),
  overrides: z.array(z.object({
    glob: z.string(), zone: ZoneName,
  })).default([]),
});
export type PermissionsManifest = z.infer<typeof PermissionsManifest>;
export type ZoneName = z.infer<typeof ZoneName>;
```

- [ ] **Step 4: Run — PASS**
- [ ] **Step 5: Commit** `feat(core): PermissionsManifest schema`

### Task 1.4: resolveZone with overlap/exclusion/override coverage

**Files:**
- Create: `packages/core/src/zones.ts`
- Test: `packages/core/test/zones.test.ts`

Rules (§4.4): excluded always wins; else most-specific glob wins (score by matched literal segments); overrides beat base zones; **unmatched → `trusted`**.

- [ ] **Step 1: Write failing tests** covering: agent path → agent; excluded overlapping agent → excluded; trusted vs agent overlap → most-specific; override beats base; unmatched → trusted.

```ts
import { expect, test } from "vitest";
import { resolveZone } from "../src/zones.js";
import { PermissionsManifest } from "../src/schemas/manifest.js";

const m = PermissionsManifest.parse({
  zones: {
    trusted: ["**"],
    agent: ["Agent/**"],
    scratch: ["Agent/Scratch/**"],
    excluded: ["Private/**", "Agent/Secret/**"],
  },
  overrides: [{ glob: "Agent/Pinned/**", zone: "trusted" }],
});

test("agent path resolves to agent", () => {
  expect(resolveZone("Agent/Memory/x.md", m)).toBe("agent");
});
test("scratch is more specific than agent", () => {
  expect(resolveZone("Agent/Scratch/tmp.md", m)).toBe("scratch");
});
test("excluded always wins over agent overlap", () => {
  expect(resolveZone("Agent/Secret/x.md", m)).toBe("excluded");
});
test("override beats base zone", () => {
  expect(resolveZone("Agent/Pinned/x.md", m)).toBe("trusted");
});
test("unmatched (only ** trusted) → trusted", () => {
  expect(resolveZone("Notes/foo.md", m)).toBe("trusted");
});
test("no match at all → trusted fallback", () => {
  const empty = PermissionsManifest.parse({ zones: { trusted: [], agent: [], scratch: [], excluded: [] } });
  expect(resolveZone("anything.md", empty)).toBe("trusted");
});
```

- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement**

```ts
import picomatch from "picomatch";
import type { PermissionsManifest, ZoneName } from "./schemas/manifest.js";

function specificity(glob: string): number {
  // more non-wildcard segments = more specific
  return glob.split("/").filter((s) => s && s !== "**" && s !== "*").length;
}

export function resolveZone(path: string, m: PermissionsManifest): ZoneName {
  const norm = path.replace(/\\/g, "/").replace(/^\.\//, "");
  // 1. excluded always wins
  if (m.zones.excluded.some((g) => picomatch(g, { dot: true })(norm))) {
    return "excluded";
  }
  // 2. overrides (most-specific override wins, but excluded already returned)
  let best: { zone: ZoneName; score: number } | null = null;
  for (const o of m.overrides) {
    if (picomatch(o.glob, { dot: true })(norm)) {
      const s = specificity(o.glob) + 100; // overrides beat base zones
      if (!best || s > best.score) best = { zone: o.zone, score: s };
    }
  }
  // 3. base zones, most-specific glob wins
  const order: ZoneName[] = ["scratch", "agent", "trusted"];
  for (const zone of order) {
    for (const g of m.zones[zone]) {
      if (picomatch(g, { dot: true })(norm)) {
        const s = specificity(g);
        if (!best || s > best.score) best = { zone, score: s };
      }
    }
  }
  // 4. fallback
  return best?.zone ?? "trusted";
}
```

- [ ] **Step 4: Run — PASS** (adjust specificity/order until all overlap cases pass)
- [ ] **Step 5: Export from `index.ts`; commit** `feat(core): resolveZone with overlap + override + fallback`

---

## Phase 2 — Transactional write broker (Build Prompt 3)

**Goal:** the broker pipeline (§5) with rejection codes, Git identity, journal, undo (with compensation + REVERT_CONFLICT), and startup reconcile.

### Task 2.1: Rejection codes & BrokerError

**Files:** Create `packages/core/src/errors.ts`; Test `packages/core/test/errors.test.ts`

- [ ] **Step 1: Failing test** — `BrokerError` carries `{ code, message, retriable }`; `REVERT_CONFLICT` present in enum.
- [ ] **Step 2: FAIL**
- [ ] **Step 3: Implement**

```ts
export const RejectionCode = {
  FORBIDDEN_ZONE: "FORBIDDEN_ZONE",
  STALE_HASH: "STALE_HASH",
  PATCH_TOO_LARGE: "PATCH_TOO_LARGE",
  SYNTAX_BREAK: "SYNTAX_BREAK",
  NOT_FOUND: "NOT_FOUND",
  TARGET_EXISTS: "TARGET_EXISTS",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  REVERT_CONFLICT: "REVERT_CONFLICT",
} as const;
export type RejectionCode = (typeof RejectionCode)[keyof typeof RejectionCode];

const RETRIABLE: Record<RejectionCode, boolean> = {
  FORBIDDEN_ZONE: false, STALE_HASH: true, PATCH_TOO_LARGE: false,
  SYNTAX_BREAK: false, NOT_FOUND: false, TARGET_EXISTS: false,
  APPROVAL_REQUIRED: true, REVERT_CONFLICT: false,
};

export class BrokerError extends Error {
  constructor(public code: RejectionCode, message: string,
    public retriable = RETRIABLE[code]) {
    super(message);
    this.name = "BrokerError";
  }
  toRejection() { return { code: this.code, message: this.message, retriable: this.retriable }; }
}
```

- [ ] **Step 4: PASS**
- [ ] **Step 5: Commit** `feat(core): rejection codes and BrokerError`

### Task 2.2: Hashing

**Files:** Create `packages/core/src/broker/hash.ts`; Test alongside.

- [ ] **Step 1: Failing test** — `hashBytes(Buffer)` returns `sha256:<hex>`; `hashFile(path)` reads and hashes; missing file → BrokerError NOT_FOUND.
- [ ] **Step 2: FAIL**
- [ ] **Step 3: Implement** with `node:crypto` + `node:fs`. Prefix format `sha256:...`.
- [ ] **Step 4: PASS** — [ ] **Step 5: Commit** `feat(core): file hashing`

### Task 2.3: Patch apply with size guard

**Files:** Create `packages/core/src/broker/patch.ts`; Test alongside.

Use the `diff` package: `applyPatch(original, patchText)` returns `string | false`. Size guard: count changed lines in the diff; if `changed / max(originalLines,1) > threshold` (default 0.5) → PATCH_TOO_LARGE.

- [ ] **Step 1: Failing tests** — clean hunk applies; malformed patch → SYNTAX_BREAK (or false → reject); >50% lines changed → PATCH_TOO_LARGE.
- [ ] **Step 2: FAIL**
- [ ] **Step 3: Implement**

```ts
import { applyPatch as diffApply, parsePatch } from "diff";
import { BrokerError } from "../errors.js";

export function applyPatch(original: string, patchText: string, threshold = 0.5): string {
  const parsed = parsePatch(patchText);
  if (parsed.length === 0) throw new BrokerError("SYNTAX_BREAK", "unparseable patch");
  let changed = 0;
  for (const file of parsed)
    for (const h of file.hunks)
      changed += h.lines.filter((l) => l.startsWith("+") || l.startsWith("-")).length;
  const originalLines = Math.max(original.split("\n").length, 1);
  if (changed / originalLines > threshold)
    throw new BrokerError("PATCH_TOO_LARGE", `patch changes ${changed} lines (> ${threshold * 100}%)`);
  const result = diffApply(original, patchText);
  if (result === false) throw new BrokerError("SYNTAX_BREAK", "patch did not apply cleanly");
  return result;
}
```

- [ ] **Step 4: PASS** — [ ] **Step 5: Commit** `feat(core): patch apply with size guard`

### Task 2.4: Markdown structure lint

**Files:** Create `packages/core/src/broker/lint.ts`; Test alongside.

Assert structural tokens **outside changed hunks** are byte-identical (§5). v0.1 heuristic: extract the set of wikilinks `[[...]]`, block refs `^id`, callout headers `> [!type]`, and the frontmatter block from `before` and `after`; any structural token that existed before and is not in a changed hunk must still exist after. Simpler robust check for v0.1: the frontmatter block (delimited by `---`) must remain valid YAML and parse via gray-matter; and the count of wikilinks/blockrefs must not decrease outside the patched line ranges.

- [ ] **Step 1: Failing tests** — a patch that corrupts frontmatter → SYNTAX_BREAK; a patch that deletes a wikilink outside its hunk → SYNTAX_BREAK; a clean content edit passes.
- [ ] **Step 2: FAIL**
- [ ] **Step 3: Implement** `assertStructurePreserved(before, after, patchText)`. Keep it deterministic; document the heuristic in comments. Throw BrokerError SYNTAX_BREAK on violation.
- [ ] **Step 4: PASS** — [ ] **Step 5: Commit** `feat(core): markdown structure preservation lint`

### Task 2.5: Git wrapper with ledger identity

**Files:** Create `packages/core/src/broker/git.ts`; Test with a temp repo fixture.

- [ ] **Step 1: Failing tests** — `commitFile(repo, path, message)` creates a commit authored `VaultLedger <ledger@local>`; message format `ledger: <op> <basename> [<mem>] <session>`; `revertCommit(sha)` reverts; a conflicting revert throws REVERT_CONFLICT and leaves tree clean (calls `git revert --abort`).
- [ ] **Step 2: FAIL**
- [ ] **Step 3: Implement** with `simple-git`. Set author via `-c user.name -c user.email` or `commit` options. `revertCommit` runs `git revert --no-edit <sha>`; on failure run `git revert --abort` and throw `BrokerError("REVERT_CONFLICT", …)`. Provide `formatMessage({op, basename, memoryId, session})`.
- [ ] **Step 4: PASS** — [ ] **Step 5: Commit** `feat(core): git wrapper with ledger identity and revert-conflict handling`

### Task 2.6: Journal (SQLite schema + typed access)

**Files:** Create `packages/core/src/journal/db.ts`, `packages/core/src/journal/journal.ts`; Tests alongside.

Tables per §3.2: `transactions`, `memories`, `memory_tags`, `approvals`, `conflicts` (empty). Open DB with WAL off for v0.1 (WAL is v1.0) — but enabling WAL now is harmless; keep default.

- [ ] **Step 1: Failing tests** — open in-memory DB, create schema; `recordTransaction(row)` then `getTransaction(id)` round-trips; `insertMemory` + `addTags` + `queryMemories({entity})`; `markMemoryStatus(id, "reverted")`.
- [ ] **Step 2: FAIL**
- [ ] **Step 3: Implement** `openJournal(dbPath)` running `CREATE TABLE IF NOT EXISTS ...` DDL, and a `Journal` class exposing typed methods. Use parameterized statements only.
- [ ] **Step 4: PASS** — [ ] **Step 5: Commit** `feat(core): SQLite journal schema and access`

### Task 2.7: Broker pipeline (create / revise / forget)

**Files:** Create `packages/core/src/broker/broker.ts`; Tests alongside with a temp vault+repo fixture.

Wire the stages. `Broker` takes `{ vaultRoot, git, journal, manifest, config }`. Method `apply(op)`:
- resolve zone; if `excluded` → FORBIDDEN_ZONE.
- **`create`**: zone must be agent/scratch else FORBIDDEN_ZONE; target must not exist else TARGET_EXISTS; write file; commit; journal.record (`hash_before=null`).
- **`revise`**: zone must be agent/scratch (trusted revise → APPROVAL_REQUIRED per §6.4); hashCheck vs `expected_hash` (mismatch → STALE_HASH); read file; `applyPatch`; `assertStructurePreserved`; write; commit; journal.record.
- **`propose_edit`**: zone should be trusted; ALWAYS enqueue approval (return `{ queued: true, approval_id }`), never apply.
- **`forget`**: resolve memory path from journal; move to `Agent/Archive/`; flip frontmatter status=forgotten; commit; journal.record; mark memory forgotten.

- [ ] **Step 1: Failing tests (one per branch):** create happy path; create onto existing → TARGET_EXISTS; revise happy path; revise stale hash → STALE_HASH; revise in excluded → FORBIDDEN_ZONE; revise in trusted → APPROVAL_REQUIRED; propose_edit → queued not applied (file bytes unchanged, approval row exists); patch too large → PATCH_TOO_LARGE; syntax break → SYNTAX_BREAK.
- [ ] **Step 2: FAIL**
- [ ] **Step 3: Implement** the pipeline. Keep each stage a small function; `apply` orchestrates.
- [ ] **Step 4: PASS**
- [ ] **Step 5: Commit** `feat(core): broker pipeline with zone/hash/patch/lint/commit/journal`

### Task 2.8: Undo with journal compensation + REVERT_CONFLICT

**Files:** Create `packages/core/src/broker/undo.ts`; Tests alongside.

- [ ] **Step 1: Failing tests:**
  - `undoTransaction(txnId)`: git revert restores prior bytes exactly; affected memory row → `reverted`; original txn → `reverted`; a new `op:'revert'` row (status `applied`) recorded; `recall` no longer returns the memory.
  - dirty revert (later commit touched same file) → REVERT_CONFLICT; working tree + journal untouched.
  - `undoSession(sessionId)`: reverts that session's commits in reverse chronological order.
- [ ] **Step 2: FAIL**
- [ ] **Step 3: Implement** using `git.revertCommit`. On REVERT_CONFLICT propagate the BrokerError (git wrapper already aborted); do NOT mutate journal. On success, perform the compensation writes in a single SQLite transaction.
- [ ] **Step 4: PASS**
- [ ] **Step 5: Commit** `feat(core): journal-compensated undo with revert-conflict handling`

### Task 2.9: Startup reconcile (crash gap)

**Files:** Create `packages/core/src/broker/reconcile.ts`; Tests alongside.

- [ ] **Step 1: Failing test** — simulate a `ledger:` commit with no matching journal row (insert commit, skip journal); `reconcile()` detects and inserts the missing transaction row from commit metadata.
- [ ] **Step 2: FAIL**
- [ ] **Step 3: Implement** — scan recent `ledger:` commits (parse structured message for txn/op/session), diff against `transactions`, repair.
- [ ] **Step 4: PASS**
- [ ] **Step 5: Commit** `feat(core): startup reconcile for commit/journal crash gap`

---

## Phase 3 — Memory store, lifecycle, approvals, recall, reindex (Build Prompt 4)

**Goal:** the memory API on top of the broker (§6), TTL, approvals, recall, and reindex (§3.3).

### Task 3.1: Config & paths

**Files:** Create `packages/core/src/config.ts`; Tests alongside.

- [ ] **Step 1: Failing tests** — `appSupportDir(vaultId)` resolves per-OS (mock `process.platform`/env); `readConfig(vaultRoot)` / `writeConfig` round-trip `.ledger/config.json` with a generated `vaultId`; `mintVaultId()` returns a stable random id (test determinism by injecting a rng).
- [ ] **Step 2: FAIL**
- [ ] **Step 3: Implement** — no `Math.random`/`Date.now` in pure functions where avoidable; accept an id generator + clock as params (injected) so tests are deterministic. Resolve base: macOS `~/Library/Application Support/VaultLedger`; Linux `$XDG_DATA_HOME` or `~/.local/share/VaultLedger`; Windows `%APPDATA%\VaultLedger`. Journal path = `<base>/<vaultId>/journal.db`.
- [ ] **Step 4: PASS** — [ ] **Step 5: Commit** `feat(core): config + app-support path resolution (vault-id keyed)`

### Task 3.2: Recall

**Files:** Create `packages/core/src/recall/recall.ts`; Tests alongside.

- [ ] **Step 1: Failing tests** — filters by `entity`, `tag`, `status`, `since`, `limit`; returns memories with full provenance; excluded-zone notes never returned (recall reads journal only, which only holds broker-written memories, so this holds by construction — assert it).
- [ ] **Step 2: FAIL**
- [ ] **Step 3: Implement** on `Journal.queryMemories`. Return `{ id, path, entity, status, provenance, tags }[]`.
- [ ] **Step 4: PASS** — [ ] **Step 5: Commit** `feat(core): journal-indexed recall`

### Task 3.3: Memory store — remember / revise / promote / forget

**Files:** Create `packages/core/src/memory/store.ts`; Tests alongside.

- [ ] **Step 1: Failing tests (one per transition):**
  - `remember(content, {entity, reason, session, tags})` → creates note in agent zone with provenance frontmatter, status `scratch`, one commit, journal + tags rows.
  - `revise(id, patch, reason, session)` → patches note, bumps provenance, sets `supersedes`.
  - `promote(id, "working", …)` when rule satisfied → updates status; when `"canonical"` → creates approval item, no write.
  - `forget(id, reason, session)` → tombstone to `Agent/Archive/`, status `forgotten`.
- [ ] **Step 2: FAIL**
- [ ] **Step 3: Implement** — `remember` builds the note body (frontmatter via gray-matter stringify + injected id/clock) and calls `broker.apply({op:'create', …})`. `promote` to canonical calls `approvals.enqueue`. Keep provenance construction in one helper.
- [ ] **Step 4: PASS** — [ ] **Step 5: Commit** `feat(core): memory store lifecycle`

### Task 3.4: Approvals queue (with stale-approval handling)

**Files:** Create `packages/core/src/approvals/queue.ts`; Tests alongside.

- [ ] **Step 1: Failing tests:**
  - `enqueue(op, zone, …)` inserts pending row.
  - `list()` returns pending items.
  - `approve(id)` re-runs the held op through the broker via **approved-execution context** (bypasses only the trusted-zone gate) and applies with all checks; row → approved.
  - **stale approval:** if the note changed so `expected_hash` no longer matches, approve() surfaces STALE_HASH and marks the row `stale` (not applied) (§6.3).
  - `reject(id)` → row rejected, nothing written.
- [ ] **Step 2: FAIL**
- [ ] **Step 3: Implement** — Broker gains an `apply(op, { approved: true })` path that skips the trusted-gate but runs hashCheck/patch/lint/commit/journal. `approve` catches BrokerError STALE_HASH → mark `stale`.
- [ ] **Step 4: PASS** — [ ] **Step 5: Commit** `feat(core): approval queue with approved-execution + stale handling`

### Task 3.5: TTL sweep & staleness

**Files:** Create `packages/core/src/memory/ttl.ts`; Tests alongside.

- [ ] **Step 1: Failing tests** — scratch older than TTL (inject clock) → archived (forget-style move); working memory unreferenced > N days → staleness flag recorded; sweep is idempotent.
- [ ] **Step 2: FAIL**
- [ ] **Step 3: Implement** `sweep(now)` (clock injected). Called lazily at CLI/MCP startup (wired later).
- [ ] **Step 4: PASS** — [ ] **Step 5: Commit** `feat(core): TTL sweep and staleness flags`

### Task 3.6: Reindex (rebuild journal from vault + Git)

**Files:** Create `packages/core/src/memory/reindex.ts`; Tests alongside.

- [ ] **Step 1: Failing tests:**
  - Given a vault with agent-zone notes + `ledger:` git history, delete the journal, run `reindex()`, assert `memories`/`memory_tags`/`transactions` are rebuilt and `recall` returns the same memories.
  - Auto-trigger: opening a known vault (config has vaultId) whose journal is missing/empty runs reindex automatically.
- [ ] **Step 2: FAIL**
- [ ] **Step 3: Implement** — walk agent zone, parse frontmatter → memories/tags; walk `ledger:` commits → transactions. Provide `ensureJournal(vaultRoot)` that auto-reindexes when empty.
- [ ] **Step 4: PASS** — [ ] **Step 5: Commit** `feat(core): journal reindex + auto-heal`

### Task 3.7: Core public API barrel

- [ ] Export the public surface from `packages/core/src/index.ts`: schemas, `resolveZone`, `Broker`, `MemoryStore`, `Approvals`, `recall`, `scanVault`, `reindex`, `reconcile`, config helpers, errors.
- [ ] Run `pnpm -C packages/core build && pnpm test`. Commit `feat(core): public API barrel`.

---

## Phase 4 — Onboarding scanner (Build Prompt 5)

**Goal:** read-only vault scan → VaultProfile + proposed manifest (§7). Never writes user folders.

### Task 4.1: scanVault

**Files:** Create `packages/core/src/scan/scanner.ts`; Test with a fixture vault.

- [ ] **Step 1: Failing tests** — counts notes + links; detects `Daily/`, `Templates/`, attachments, likely projects; proposed manifest: `trusted:["**"]`, `agent:["Agent/**"]`, `scratch:["Agent/Scratch/**"]`, `excluded:["Private/**"]` iff `Private/` exists; **asserts scanner wrote nothing** (snapshot fixture dir hash before/after).
- [ ] **Step 2: FAIL**
- [ ] **Step 3: Implement** — walk with excludes (`.git`, `.obsidian`, `node_modules`), `gray-matter` for frontmatter, light `\[\[([^\]]+)\]\]` regex for links. Pure read.
- [ ] **Step 4: PASS** — [ ] **Step 5: Commit** `feat(core): read-only vault scanner`

---

## Phase 5 — CLI (Build Prompt 6)

**Goal:** `ledger init|status|approve|undo|log|reindex` (§8). Thin over core.

### Task 5.1: CLI program + init

**Files:** Create `packages/cli/src/index.ts`, `packages/cli/src/commands/init.ts`; Tests alongside.

- [ ] **Step 1: Failing test** — `init(vaultDir, {confirm:true})` runs scan, writes `.ledger/permissions.yaml` + `config.json`, `git init` if absent, mints vaultId; a second `init` is idempotent; without confirm it prints profile and writes nothing.
- [ ] **Step 2: FAIL**
- [ ] **Step 3: Implement** — commander program; `init` action calls `scanVault` then writes `.ledger/`. Keep IO in the command; logic in core.
- [ ] **Step 4: PASS** — [ ] **Step 5: Commit** `feat(cli): ledger init`

### Task 5.2: status / log / reindex

- [ ] TDD each: `status` prints zones + pending approvals + last 10 txns; `log --entity/--session` filters; `reindex` calls core. Run TTL sweep + `ensureJournal` at startup of each command. Commit per command.

### Task 5.3: approve (colored diffs) + undo

- [ ] **Step 1: Failing tests** — `approve id` applies via core and prints a diff (use `diff` lib, color optional/injectable so tests assert plain text); stale approval prints STALE_HASH and marks stale; `undo <txn|session>` calls core; REVERT_CONFLICT prints a clear message and exits non-zero.
- [ ] **Steps 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(cli): approve and undo`

---

## Phase 6 — MCP server (Build Prompt 7)

**Goal:** the 7 spec §7 tools over stdio, validating with core schemas (§9).

### Task 6.1: Tool layer

**Files:** Create `packages/mcp-server/src/tools.ts`; Tests call the handlers directly.

- [ ] **Step 1: Failing tests** — each tool validates input with the zod schema and routes to core: `memory_remember` → store.remember; `memory_recall` filters; `memory_revise`; `memory_promote`; `memory_forget`; `vault_propose_edit` → queued result; `ledger_status`. Invalid input → structured error.
- [ ] **Step 2: FAIL**
- [ ] **Step 3: Implement** — a `buildTools(core)` factory returning tool defs `{ name, inputSchema (zod), handler }`. `recall` filters: entity, tag, status, since, limit.
- [ ] **Step 4: PASS** — [ ] **Step 5: Commit** `feat(mcp): tool layer over core`

### Task 6.2: stdio entrypoint + example config

**Files:** Create `packages/mcp-server/src/index.ts`, `packages/mcp-server/examples/mcp.json`.

- [ ] **Step 1: Failing integration test** — spawn the server over a fixture vault; run `remember → recall → revise → undo`; assert recall reflects each step.
- [ ] **Step 2: FAIL**
- [ ] **Step 3: Implement** — wire `@modelcontextprotocol/sdk` `Server` with stdio transport; register tools; on startup `ensureJournal` + `reconcile` + TTL sweep. `examples/mcp.json`:

```json
{
  "mcpServers": {
    "vaultledger": {
      "command": "vaultledger-mcp",
      "args": ["--vault", "/absolute/path/to/vault"]
    }
  }
}
```

- [ ] **Step 4: PASS** — [ ] **Step 5: Commit** `feat(mcp): stdio entrypoint + example config`

---

## Phase 7 — End-to-end proof (Build Prompt 8 — v0.1 gate)

**Goal:** the six-step scenario from §1 as an automated test + README walkthrough.

### Task 7.1: e2e test

**Files:** Create `packages/mcp-server/test/e2e.test.ts` (or a top-level `e2e/` package); fixture vault under `test/fixtures/`.

- [ ] **Step 1: Write the e2e test** asserting, in order:
  1. `ledger init` on a fixture vault with existing notes writes only `.ledger/`.
  2. Session A: `remember` 3 facts + `vault_propose_edit` 1 trusted note.
  3. The trusted edit is **queued, not applied**; the 3 memories carry provenance; Git has **one commit per applied transaction**.
  4. Fresh session B: `recall` returns session A's memories with provenance.
  5. `undo` of one transaction restores prior file bytes **exactly** AND `recall` no longer returns that memory.
  6. A write to an excluded path → clean rejection (FORBIDDEN_ZONE).
- [ ] **Step 2: Run — FAIL** on the first unimplemented seam; fix seams until green.
- [ ] **Step 3: Run full suite** `pnpm test` — Expected: all green.
- [ ] **Step 4: Commit** `test(e2e): v0.1 governed-write loop proof`

### Task 7.2: README walkthrough

- [ ] Add a "2-minute walkthrough" to `README.md`: install, `ledger init`, wire `.mcp.json`, do a remember/recall, show `ledger status`, `ledger undo`. Commit `docs: v0.1 demo walkthrough`.

### Task 7.3: v0.1 gate verification

- [ ] REQUIRED SUB-SKILL: superpowers:verification-before-completion. Run `pnpm build && pnpm test && pnpm lint` and paste output. Only then mark v0.1 complete. Push to `origin main`.

---

## Sequencing & dependency notes

- Phases are strictly ordered; within a phase, tasks are ordered by dependency.
- The journal (2.6) must land before broker (2.7); broker before memory store (3.3); memory store before recall assertions and e2e.
- `config.ts` (3.1) is used by CLI/MCP startup; it can be built early if convenient but only the CLI/MCP phases require it.
- Determinism: inject id-generator and clock into anything that stamps `created`/`id`/`expires` so tests avoid `Date.now()`/`Math.random()`.
- Commit after every green test. Keep `cli`/`mcp-server` free of business logic — if a test wants logic there, move it to `core`.
