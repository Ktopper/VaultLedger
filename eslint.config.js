import tseslint from "typescript-eslint";
export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "packages/obsidian-plugin/main.js"] },
  ...tseslint.configs.recommended,
  {
    // Bundle-purity guard, lint half (test/bundlePurity.test.ts is the real
    // guarantee): a VALUE import of the `@vaultledger/core` barrel from the
    // plugin's src/ pulls the native-dependent core graph (better-sqlite3,
    // simple-git, proper-lockfile) into the esbuild bundle, whose top-level
    // native require would crash the plugin on load. Value symbols must come
    // from the narrow "@vaultledger/core/config" subpath instead; `import
    // type` from the barrel is fine (erased at compile time).
    files: ["packages/obsidian-plugin/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@vaultledger/core",
              message:
                "Value imports from the @vaultledger/core barrel pull the native-dependent graph (better-sqlite3, ...) into the plugin bundle and crash it on load. Import values from '@vaultledger/core/config'; `import type` from the barrel is allowed.",
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
);
