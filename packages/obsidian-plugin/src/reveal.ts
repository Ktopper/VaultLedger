/**
 * Reveal-decision helper, extracted from `activateView` so the decision is
 * unit-testable without a headless Obsidian (main.ts itself imports obsidian
 * value symbols and can't run under vitest).
 *
 * The rule: refresh IFF a leaf of the view already existed. A brand-new leaf
 * pulls its data through the view's `onOpen`, so refreshing it again would be a
 * redundant double-fetch. A RE-revealed existing leaf does NOT re-run `onOpen`,
 * so without this its contents would be whatever they were when last rendered
 * (stale) — the whole point of re-revealing is usually to see fresh data.
 *
 * Returns whether a refresh was issued (for the caller's test to assert on).
 */
export function refreshOnReveal(existingCount: number, refresh: () => void): boolean {
  if (existingCount > 0) {
    refresh();
    return true;
  }
  return false;
}
