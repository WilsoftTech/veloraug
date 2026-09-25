import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Catalogue integration tests: real PostgREST queries against the LOCAL
 * Supabase stack seeded with supabase/seeds/dev-catalogue.sql. Run through
 * `npm run test:catalogue`, which resets and seeds the local database first.
 * Never points at hosted: the URL and key come from `supabase status`.
 */
function localSupabase() {
  const status = JSON.parse(execSync("npx supabase@2.117.0 status -o json", { encoding: "utf8" })) as Record<string, string>;
  if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(status.API_URL ?? "")) {
    throw new Error("Catalogue integration tests only run against a local Supabase stack.");
  }
  return {
    NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.PUBLISHABLE_KEY,
    // LOCAL stack keys for the ingestion worker store test only: service_role
    // (allowed) and the legacy anon JWT (must be denied by PostgreSQL grants).
    SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    LOCAL_ANON_JWT: status.ANON_KEY,
  };
}

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": root,
      // `server-only` throws outside a React Server Components bundle.
      "server-only": fileURLToPath(new URL("./tests/integration/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    env: { ...localSupabase(), TMDB_ACCESS_TOKEN: "", TMDB_API_KEY: "" },
    fileParallelism: false,
  },
});
