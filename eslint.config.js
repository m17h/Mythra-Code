import eslint from "@eslint/js";
import babelParser from "@babel/eslint-parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  { ignores: ["dist/**", "node_modules/**", "src-tauri/target/**"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    ...eslint.configs.recommended,
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          // Babel receives each real filename from ESLint, so the TypeScript
          // preset can distinguish .ts from .tsx and enable JSX only where it
          // is valid. Forcing one mode for both breaks one of the two groups.
          presets: ["@babel/preset-typescript"],
        },
      },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
