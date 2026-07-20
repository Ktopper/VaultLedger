// The real "VaultLedger Approval Test" note from field finding #7 (live 0.4.5
// testing — the note Hermes was trying to edit when it hit the no-read-tool
// wall). Captured byte-for-byte on the Ferv vault via `shasum -a 256` / `wc -c`
// / `xxd` (incident state, unmodified): 150 bytes, LF endings, no BOM, no
// trailing whitespace, a single trailing newline.
//
// Stored as base64 so the EXACT bytes survive — especially the trailing-newline
// state, which `cat`/`sed` can't disambiguate and a hand-typed template literal
// would get wrong. The tests self-check that these bytes hash to the digest
// captured on the real vault, so any drift from the real note fails loudly.
export const TESTING_NOTE_BASE64 =
  "IyBWYXVsdExlZGdlciBBcHByb3ZhbCBUZXN0CgpUaGlzIGlzIGEgc2Vjb25kIGRpc3Bvc2FibGUgcHJvcG9zYWwgZm9yIHRlc3RpbmcgdGhlIHRydXN0ZWQtem9uZSBodW1hbi1hcHByb3ZhbCB3b3JrZmxvdy4KCkNyZWF0ZWQ6IDIwMjYtMDctMThfMTItMTgtMDAK";

export const TESTING_NOTE_BYTES = Buffer.from(TESTING_NOTE_BASE64, "base64");

/** The `shasum -a 256` captured on the real vault, in the broker's canonical form. */
export const TESTING_NOTE_SHA256 =
  "sha256:55bf4472169d83d1a0bf3da6dd03d010d3406a0c0ba2ae0b72d0d0b5e3add67b";

/** The real `wc -c`. */
export const TESTING_NOTE_SIZE = 150;
