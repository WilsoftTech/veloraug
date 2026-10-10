import { down, up } from "../../scripts/isolated-db.mjs";

// A fresh database (all migrations + the dev catalogue seed) and PostgREST per run.
export default function setup() {
  if (process.env.VELORA_E38_ISOLATED_TESTS !== "true") throw new Error("isolated_tests_only");
  up({ rest: true, seed: true });
  return () => { if (process.env.VELORA_KEEP_ISOLATED !== "true") down(); };
}
