import type { requestUrl as RequestUrlFn } from "obsidian"; // TYPE ONLY — erased at compile; the real fn is injected from main.ts

/**
 * A `fetch`-shaped adapter over Obsidian's `requestUrl`. This is the PRIMARY
 * fix for the empty-views bug: inside real Obsidian the plugin runs at the
 * `app://obsidian.md` origin, so a browser `fetch` carrying `Authorization` +
 * `Content-Type` headers triggers a CORS preflight the bridge (correctly)
 * doesn't answer — every request is blocked before auth. `requestUrl` is
 * Obsidian's own host-side HTTP path: it is NOT subject to the browser's
 * same-origin / preflight machinery, so the request reaches the bridge.
 *
 * The real `requestUrl` is passed in as a PARAMETER (not imported as a value)
 * so this adapter stays Node-unit-testable with a fake — `import { requestUrl }
 * from "obsidian"` can't run under vitest (obsidian is a host-provided module,
 * external in the esbuild bundle). main.ts does the real value import and
 * injects it.
 */

/** Statuses whose bodies MUST be null when constructing a `Response`, or the
 * DOM `Response` constructor throws ("Response with null body status cannot
 * have body"). Fold 3: a 204/205/304 from the bridge must not blow up here. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export function makeRequestUrlTransport(requestUrl: typeof RequestUrlFn): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const call = requestUrl({
      url,
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string> | undefined,
      body: typeof init?.body === "string" ? init.body : undefined,
      // Suppress STATUS-based throws so a 4xx/5xx comes back as a real Response
      // (BridgeClient shapes it into a typed error). A CONNECTION-level failure
      // still REJECTS the promise — that's fold 2, and it must throw through so
      // BridgeClient's reconnect can arm.
      throw: false,
    });

    const signal = init?.signal ?? undefined;
    let r;
    if (signal) {
      const abort = new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason as unknown);
        else signal.addEventListener("abort", () => reject(signal.reason as unknown), { once: true });
      });
      // If the timeout (abort) wins the race, `call` is left dangling — its
      // later settle would surface as an unhandled rejection. Swallow it.
      void call.catch(() => {});
      r = await Promise.race([call, abort]);
    } else {
      r = await call; // a connection-level rejection throws through here (fold 2)
    }

    const body = NULL_BODY_STATUSES.has(r.status) ? null : r.text; // fold 3
    return new Response(body, { status: r.status, headers: r.headers });
  }) as typeof fetch;
}
