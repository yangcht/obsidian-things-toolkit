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
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          brands: [
            "AppleScript",
            "Full Disk Access",
            "Mac",
            "macOS",
            "Obsidian",
            "Obsidian Sync",
            "SQLite",
            "Things",
            "Things Toolkit",
          ],
          acronyms: ["ISO", "MD"],
          ignoreRegex: ["#things/work"],
          enforceCamelCaseLower: true,
        },
      ],
    },
  }
);
