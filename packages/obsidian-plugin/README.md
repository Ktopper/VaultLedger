# VaultLedger — Obsidian plugin (v0.2)

The "what does my agent believe?" review surface for
[VaultLedger](../../README.md): an approval queue with rendered diffs, an agent-
activity view with one-click undo, provenance on hover, and a staleness list.

It is a thin HTTP client over the `ledger serve` bridge — it holds no vault logic
and writes nothing directly; every mutation goes through the broker via the
bridge. Diffs and note content are rendered into the DOM with `textContent` only
(never `innerHTML`), so agent-written content can't inject markup.

## Build & install

```sh
pnpm -C packages/obsidian-plugin build          # produces main.js (bundled, no native deps)
```

Copy `manifest.json` + `main.js` into `<vault>/.obsidian/plugins/vaultledger/`,
enable **VaultLedger** in Community Plugins, then run `ledger serve <vault>`. See
[`SMOKE.md`](SMOKE.md) for the manual verification checklist.

## Structure

- `src/bridgeClient.ts` — typed client + app-support discovery (unit-tested).
- `src/render.ts` — pure XSS-safe DOM builders (unit-tested, incl. a hostile-diff
  fixture).
- `src/views/*`, `src/hover.ts`, `src/main.ts` — thin Obsidian glue (manually
  verified per `SMOKE.md`; no headless Obsidian to automate against).
