import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests for framework-free modules. Mirrors the tsconfig "@/*" alias.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { include: ["lib/**/*.test.ts"], environment: "node" },
});
