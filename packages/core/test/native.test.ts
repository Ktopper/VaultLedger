import { describe, expect, test } from "vitest";
import { probeNativeDeps, explainNativeBindingError } from "../src/native.js";

describe("probeNativeDeps", () => {
  test("a working better-sqlite3 install → ok (forces the binding to load)", () => {
    const r = probeNativeDeps();
    expect(r.ok).toBe(true);
  });
});

describe("explainNativeBindingError", () => {
  test("the classic missing-binding error → a one-line remediation", () => {
    const e = new Error(
      "Could not locate the bindings file. Tried:\n → /a/build/better_sqlite3.node\n → /b/...",
    );
    const msg = explainNativeBindingError(e);
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/approve-builds|npm rebuild better-sqlite3/);
    // Collapses the multi-line dump to a single line.
    expect(msg!.split("\n").length).toBe(1);
  });

  test("a wrong-ABI / wrong-arch load error → also remapped", () => {
    expect(
      explainNativeBindingError(new Error("invalid ELF header")),
    ).not.toBeNull();
    expect(
      explainNativeBindingError(
        new Error("The module was compiled against a different Node.js version"),
      ),
    ).not.toBeNull();
  });

  test("an unrelated error → null (pass through untouched)", () => {
    expect(explainNativeBindingError(new Error("no config found at .ledger/config.json"))).toBeNull();
    expect(explainNativeBindingError("some string")).toBeNull();
  });
});
