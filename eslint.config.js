import tseslint from "typescript-eslint";
export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "packages/obsidian-plugin/main.js", "security/poc/**"] },
  ...tseslint.configs.recommended,
  {
    // Bundle-purity guard, lint half (test/bundlePurity.test.ts is the real
    // guarantee): a VALUE import of the `@vault-ledger/core` barrel from the
    // plugin's src/ pulls the native-dependent core graph (better-sqlite3,
    // simple-git, proper-lockfile) into the esbuild bundle, whose top-level
    // native require would crash the plugin on load. Value symbols must come
    // from the narrow "@vault-ledger/core/config" subpath instead; `import
    // type` from the barrel is fine (erased at compile time).
    files: ["packages/obsidian-plugin/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@vault-ledger/core",
              message:
                "Value imports from the @vault-ledger/core barrel pull the native-dependent graph (better-sqlite3, ...) into the plugin bundle and crash it on load. Import values from '@vault-ledger/core/config'; `import type` from the barrel is allowed.",
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
);
