import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the source tree — tsc also emits compiled *.test.js into dist/,
    // which would otherwise run every suite twice.
    include: ["src/**/*.test.ts"],
  },
});
