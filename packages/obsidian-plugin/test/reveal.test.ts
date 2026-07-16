import { describe, expect, test, vi } from "vitest";
import { refreshOnReveal } from "../src/reveal.js";

describe("refreshOnReveal", () => {
  test("an EXISTING leaf (count > 0) is refreshed", () => {
    const refresh = vi.fn();
    const refreshed = refreshOnReveal(1, refresh);
    expect(refreshed).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("a brand-new leaf (count === 0) is NOT refreshed — onOpen already fetched", () => {
    const refresh = vi.fn();
    const refreshed = refreshOnReveal(0, refresh);
    expect(refreshed).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  test("more than one existing leaf still refreshes exactly once", () => {
    const refresh = vi.fn();
    expect(refreshOnReveal(3, refresh)).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
