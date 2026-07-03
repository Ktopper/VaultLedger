import tseslint from "typescript-eslint";
export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "packages/obsidian-plugin/main.js"] },
  ...tseslint.configs.recommended,
);
