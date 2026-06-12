// Flat ESLint config. Intentionally light — the code is already clean by
// discipline; the goal is drift prevention, not churn. Prettier owns formatting
// (eslint-config-prettier last disables any stylistic rules that would fight it).
import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      ".venv/**",
      "test/.tmp/**",
      "classifier/data/**",
      "data/**",
      "**/__pycache__/**"
    ]
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      // The repo mixes service-worker/browser extension code, content scripts,
      // and Node tooling (compiler, tests). One permissive global set keeps the
      // config simple; no-undef still catches genuine typos.
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...globals.node
      }
    },
    rules: {
      eqeqeq: ["error", "smart"], // allow == null, the one intended loose compare
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }
      ],
      "no-empty": ["error", { allowEmptyCatch: true }], // fail-open catch blocks are deliberate
      "no-control-regex": "off" // intentional: the compiler's ASCII-range domain check uses \x00-\x7f
    }
  },
  prettier
];
