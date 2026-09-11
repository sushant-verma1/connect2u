// @ts-check
import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import prettierConfig from "eslint-config-prettier";

/** Node.js builtins and I/O-shaped globals packages/core must never reach for (I1). */
const coreForbiddenImports = [
  "node:*",
  "fs",
  "fs/promises",
  "http",
  "https",
  "net",
  "dns",
  "crypto",
  "child_process",
  "worker_threads",
  "cluster",
  "@otp-router/db",
  "@otp-router/db/*",
  "@otp-router/providers",
  "@otp-router/providers/*",
];

export default [
  js.configs.recommended,
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // TypeScript itself catches undefined identifiers; no-undef false-positives on
      // ambient globals like `NodeJS` and `process`.
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { ignoreRestSiblings: true, argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      // I6: crypto randomness only, never Math.random, anywhere in the codebase.
      "no-restricted-properties": [
        "error",
        {
          object: "Math",
          property: "random",
          message:
            "Math.random is forbidden (I6). Use crypto.randomInt or the injected seeded PRNG.",
        },
      ],
    },
  },
  {
    // I1: packages/core has zero I/O. Enforced structurally, not by convention.
    files: ["packages/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: coreForbiddenImports.map((pattern) => ({
            group: [pattern],
            message: "packages/core has zero I/O (I1). Pass data in from the caller instead.",
          })),
        },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "Math",
          property: "random",
          message: "Math.random is forbidden (I6).",
        },
        {
          object: "Date",
          property: "now",
          message: "packages/core has zero I/O (I1). Inject the current time from the caller.",
        },
      ],
    },
  },
  prettierConfig,
];
