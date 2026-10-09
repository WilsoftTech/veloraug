import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Dedicated disposable PostgREST only. Does not consult .env.local or supabase status/reset.
if (process.env.VELORA_E38_ISOLATED_TESTS !== "true") throw new Error("explicit_isolated_fixture_setup_required");
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)), "server-only": fileURLToPath(new URL("./tests/integration/server-only-stub.ts", import.meta.url)) } },
  test: {
    include: ["tests/integration/catalogue.test.ts", "tests/integration/discovery-publication.test.ts"], fileParallelism: false, environment: "node",
    setupFiles: ["./tests/integration/discovery-isolated-fetch.ts"],
    // Docker Desktop exec takes several seconds per real query; preserve every assertion.
    testTimeout: 120000,
    env: { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54329", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "synthetic-offline-key", TMDB_ACCESS_TOKEN: "", TMDB_API_KEY: "" },
  },
});
