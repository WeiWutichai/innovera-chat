import { defineConfig } from "vitest/config";
import path from "node:path";

const alias = { "@": path.resolve(import.meta.dirname, "src") };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["tests/setup/global-database.ts"],
          setupFiles: ["tests/setup/use-test-database.ts"],
          // Integration tests share one database and mutate process-wide limiter
          // state, so they must not run concurrently with each other.
          fileParallelism: false,
          sequence: { concurrent: false },
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "migration",
          environment: "node",
          include: ["tests/migration/**/*.test.ts"],
          globalSetup: ["tests/setup/global-database.ts"],
          setupFiles: ["tests/setup/use-test-database.ts"],
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "runtime",
          environment: "node",
          include: ["tests/runtime/**/*.test.ts"],
          fileParallelism: false,
          testTimeout: 300_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
});
