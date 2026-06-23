import js from "@eslint/js";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "eslint.config.mjs",
      "main.js",
      "rollup.config.js",
      "node_modules/**",
      "dist/**",
      "test/**",
    ],
  },

  ...obsidianmd.configs.recommended,

  {
    files: ["src/**/*.ts"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",

      /*
       * Type safety is enforced by `npm run typecheck`.
       * These rules are too noisy in Obsidian plugin review environments where
       * Obsidian APIs and DOM extensions can be treated as error/any types.
       */
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",

      /*
       * Keep deprecation and UI text checks visible, but do not fail the build.
       * Some Obsidian APIs, especially PluginSettingTab.display(), are still
       * widely used even though Obsidian recommends newer APIs.
       */
      "@typescript-eslint/no-deprecated": "warn",
      "obsidianmd/ui/sentence-case": "warn",
    },
  }
);