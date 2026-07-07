import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "dist/**"],
  },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "FunctionDeclaration[id.name='isRecord'], VariableDeclarator[id.name='isRecord']",
          message:
            "Do not define `isRecord`. Generic record guards usually mean an `unknown` boundary leaked inward. Parse the boundary into a named DTO/domain type first; if a guard remains, give it a domain-specific name and type.",
        },
      ],
    },
  },
);
