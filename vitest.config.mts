import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests for framework-free and server/CLI modules. Mirrors the tsconfig
// "@/*" alias; `server-only` throws outside a React Server Components bundle.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/integration/server-only-stub.ts", import.meta.url)),
    },
  },
  test: { include: ["lib/**/*.test.ts"], environment: "node" },
});
