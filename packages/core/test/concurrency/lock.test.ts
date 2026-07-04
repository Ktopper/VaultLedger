import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withVaultLock, LOCK_CONFIG } from "../../src/concurrency/lock.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("withVaultLock", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test("returns fn's result, and a second call afterward (lock released) succeeds", async () => {
    dir = mkdtempSync(join(tmpdir(), "vl-lock-"));

    const first = await withVaultLock(dir, async () => "first-result");
    expect(first).toBe("first-result");

    const second = await withVaultLock(dir, async () => "second-result");
    expect(second).toBe("second-result");
  });

  test("serializes overlapping critical sections: never more than one runs at once", async () => {
    dir = mkdtempSync(join(tmpdir(), "vl-lock-"));

    let active = 0;
    let max = 0;
    const order: number[] = [];

    async function critical(id: number): Promise<number> {
      return withVaultLock(dir!, async () => {
        active += 1;
        max = Math.max(max, active);
        order.push(id);
        await sleep(30);
        active -= 1;
        return id;
      });
    }

    const results = await Promise.all([critical(1), critical(2), critical(3)]);

    expect(results.sort()).toEqual([1, 2, 3]);
    expect(max).toBe(1);
    expect(active).toBe(0);
  });

  test("a slow critical section (longer than `update`, well under `stale`) is not stolen: the second acquirer waits for it to fully finish", async () => {
    dir = mkdtempSync(join(tmpdir(), "vl-lock-"));

    const events: string[] = [];

    const slow = withVaultLock(dir, async () => {
      events.push("slow-start");
      await sleep(5000);
      events.push("slow-end");
      return "slow";
    });

    // Give the slow acquirer a head start so it definitely wins the lock first.
    await sleep(100);

    const fast = withVaultLock(dir, async () => {
      events.push("fast-start");
      events.push("fast-end");
      return "fast";
    });

    const [slowResult, fastResult] = await Promise.all([slow, fast]);

    expect(slowResult).toBe("slow");
    expect(fastResult).toBe("fast");
    // The fast acquirer must not start until the slow one has fully finished —
    // proves the lock's periodic mtime `update` (2s) kept it from being
    // declared stale before the 20s `stale` threshold, even though the
    // critical section ran longer than `update`.
    expect(events).toEqual(["slow-start", "slow-end", "fast-start", "fast-end"]);
  }, 15000);

  test("LOCK_CONFIG.update is well under LOCK_CONFIG.stale (staleness-safe)", () => {
    expect(LOCK_CONFIG.update).toBeLessThan(LOCK_CONFIG.stale);
  });
});
