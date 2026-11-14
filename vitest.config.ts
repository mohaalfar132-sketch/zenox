import { defineConfig } from "vitest/config";

// Only the project's own tests run. Bundles and delivered copies (for example
// artifacts/ZANOX9) carry spare test files and must never be executed twice.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", "dist/**", "dist-web/**", "artifacts/**"],
  },
});
