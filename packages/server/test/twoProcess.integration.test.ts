import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { loadContext } from "@vault-ledger/cli";
import { startBridge, type RunningBridge } from "../src/start.js";
import { makeTestVault, type TestVault } from "./helpers.js";

const TOKEN = "two-process-test-token";

let vault: TestVault | undefined;
let bridge: RunningBridge | undefined;

afterEach(async () => {
  if (bridge) {
    await bridge.close();
    bridge = undefined;
  }
  if (vault) {
    vault.cleanup();
    vault = undefined;
  }
});

function gitStatusPorcelain(dir: string): string {
  return execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim();
}

/**
 * Task 2.5's load-bearing test: the fastify bridge (startBridge, listening
 * for real on 127.0.0.1) and a SECOND, independently-loaded context
 * (`loadContext` from `@vault-ledger/cli` — the CLI's real non-openVault
 * wiring path, used here instead of the MCP server's `loadServerContext`
 * because that function isn't re-exported from `@vault-ledger/mcp-server`'s
 * public entrypoint; `loadContext` IS re-exported from `@vault-ledger/cli`'s
 * index, so it's a genuine second real host wired independently of
 * `openVault`) both operate on the SAME vault + SAME injected HOME
 * concurrently: the bridge serves real HTTP `GET /memories` reads over its
 * own VaultContext/Broker while the CLI-context writer performs several
 * `store.remember`s. Both go through `vaultLockDir` (see core's
 * concurrency/lock.ts) for their mutations, so this proves real
 * cross-host mutual exclusion — not merely two calls inside one already-
 * serialized broker instance.
 */
describe("startBridge two-process safety", () => {
  test(
    "a CLI-loaded writer context and the bridge's HTTP reads interleave safely: all writes land, git stays clean, reads never fail",
    async () => {
      vault = await makeTestVault();
      // makeTestVault itself leaves `.ledger/` and `Notes/` untracked (it
      // never makes an initial commit) — that's pre-existing setup dirt, not
      // something the concurrent writes below should introduce MORE of.
      // Compare against this baseline rather than assuming a fully clean tree.
      const baselineStatus = gitStatusPorcelain(vault.vaultDir);

      bridge = await startBridge(vault.vaultDir, { token: TOKEN, env: vault.env });
      expect(bridge.port).toBeGreaterThan(0);
      const baseUrl = `http://127.0.0.1:${bridge.port}`;
      const fetchHeaders = { authorization: `Bearer ${TOKEN}` };

      // A second, independently-wired real host over the SAME vault + SAME
      // env — NOT openVault, so this is genuinely a different wiring path
      // (mirrors what `ledger` CLI invocations do) sharing the same
      // vaultLockDir as the bridge's own Broker.
      const writerCtx = await loadContext(vault.vaultDir, { env: vault.env });

      const WRITE_COUNT = 8;
      const readStatuses: number[] = [];
      let keepReading = true;

      const reader = (async () => {
        while (keepReading) {
          const res = await fetch(`${baseUrl}/memories`, { headers: fetchHeaders });
          readStatuses.push(res.status);
          // Drain the body so the connection can be reused/closed cleanly.
          await res.json();
          await new Promise((r) => setTimeout(r, 5));
        }
      })();

      const writtenIds: string[] = [];
      for (let i = 0; i < WRITE_COUNT; i++) {
        const { id } = await writerCtx.store.remember({
          content: `# concurrent fact ${i}\n`,
          reason: "two-process test",
          session: "writer-session",
        });
        writtenIds.push(id);
      }

      keepReading = false;
      await reader;
      writerCtx.db.close();

      // Every write actually landed: the bridge's own journal view (same
      // vault, same app-support dir) sees every remembered memory.
      const finalRes = await fetch(`${baseUrl}/memories?limit=100`, { headers: fetchHeaders });
      expect(finalRes.status).toBe(200);
      const memories = (await finalRes.json()) as Array<{ id: string }>;
      const seenIds = new Set(memories.map((m) => m.id));
      for (const id of writtenIds) {
        expect(seenIds.has(id)).toBe(true);
      }

      // No NEW dirt: every write was committed by the broker (create +
      // journal row), never left as an uncommitted working-tree change on
      // top of the pre-existing baseline.
      expect(gitStatusPorcelain(vault.vaultDir)).toBe(baselineStatus);

      // Every read succeeded throughout the concurrent writes — no 500s, no
      // connection resets from a mid-write lock contention.
      expect(readStatuses.length).toBeGreaterThan(0);
      expect(readStatuses.every((s) => s === 200)).toBe(true);

      // Journal is consistent: a transaction row exists for every write.
      const txRes = await fetch(`${baseUrl}/transactions?limit=100`, { headers: fetchHeaders });
      const txns = (await txRes.json()) as Array<{ op: string }>;
      const createCount = txns.filter((t) => t.op === "create").length;
      expect(createCount).toBeGreaterThanOrEqual(WRITE_COUNT);
    },
    30_000,
  );
});
