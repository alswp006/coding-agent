import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  // Override / extend ignores
  globalIgnores([
    // Existing ignores
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",

    // Add these
    "node_modules/**",
    "dist/**",
    "src/ruby-3.2.0/**",
  ]),
]);

export default eslintConfig;
