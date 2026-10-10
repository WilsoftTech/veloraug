import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { ISOLATED, isolatedJwt } from "./scripts/isolated-db.mjs";

const ISOLATED_REST = `http://127.0.0.1:${ISOLATED.restPort}`;
const ORDER = ["tests/integration/catalogue.test.ts", "tests/integration/discovery-publication.test.ts", "tests/integration/direct-channel-publication.test.ts"];

// One shared disposable database: the seed-exact catalogue suite runs first, then the suites that publish.
class InOrder extends BaseSequencer {
  async sort(files: TestSpecification[]) {
    const rank = (file: TestSpecification) => ORDER.findIndex((path) => file.moduleId.replaceAll("\\", "/").endsWith(path));
    return [...files].sort((a, b) => rank(a) - rank(b));
  }
}

// Disposable isolated database + PostgREST only (scripts/isolated-db.mjs, rebuilt
// per run). Does not consult .env.local, `supabase status` or reset local Supabase.
if (process.env.VELORA_E38_ISOLATED_TESTS !== "true") throw new Error("explicit_isolated_fixture_setup_required");
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)), "server-only": fileURLToPath(new URL("./tests/integration/server-only-stub.ts", import.meta.url)) } },
  test: {
    include: ORDER, sequence: { sequencer: InOrder },
    fileParallelism: false, environment: "node",
    globalSetup: ["./tests/integration/isolated-global-setup.mjs"],
    setupFiles: ["./tests/integration/discovery-isolated-fetch.ts"],
    testTimeout: 120000, hookTimeout: 300000,
    env: { NEXT_PUBLIC_SUPABASE_URL: ISOLATED_REST, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: isolatedJwt({ role: "anon" }), TMDB_ACCESS_TOKEN: "", TMDB_API_KEY: "" },
  },
});
