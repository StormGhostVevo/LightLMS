import js from "@eslint/js";
import globals from "globals";

const rules = {
  eqeqeq: ["error", "always", { null: "ignore" }],
  "no-var": "error",
  "prefer-const": "error",
  // Catches a local name hiding an imported or outer one, which once made a helper silently stop working.
  "no-shadow": "error",
  "no-unused-vars": [
    "error",
    { args: "after-used", argsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true },
  ],
  "no-throw-literal": "error",
  "no-implicit-coercion": ["error", { allow: ["!!"] }],
};

export default [
  { ignores: ["node_modules/**", "data/**", ".claude/**"] },
  js.configs.recommended,
  {
    files: ["server/**/*.js", "eslint.config.js"],
    languageOptions: { sourceType: "module", globals: globals.node },
    rules,
  },
  { files: ["public/**/*.js"], languageOptions: { sourceType: "module", globals: globals.browser }, rules },
];
