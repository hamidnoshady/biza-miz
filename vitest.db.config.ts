import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // A database test may import a server page to check the props it computes
  // against the routes behind it (#854 follow-up); tsconfig keeps
  // `jsx: "preserve"` for Next's compiler, so esbuild runs the automatic
  // runtime itself — the same setting as vitest.config.ts.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["integration/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
