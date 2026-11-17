import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**", "data/**", "render/public/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Real bugs, not style. Prettier-style formatting is deliberately not enforced.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off", // tests use `any` for fake transports and parsed JSON
      "no-console": "off", // the server logs to stderr on purpose; see src/core/logger.ts
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
      "no-throw-literal": "error",
    },
  },
  { files: ["render/**/*.tsx"], languageOptions: { globals: { ...globals.browser } } },
);
