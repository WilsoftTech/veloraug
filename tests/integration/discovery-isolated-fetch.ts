import { ISOLATED_REST } from "./isolated-env";

// Reach the disposable PostgREST (scripts/isolated-db.mjs) only. supabase-js
// addresses it as <url>/rest/v1/...; PostgREST serves at its root. Any other
// destination is refused, so no test can reach hosted Supabase or TMDB.
if (process.env.VELORA_E38_ISOLATED_TESTS !== "true") throw new Error("isolated_tests_only");
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input));
  if (url.origin !== ISOLATED_REST || !url.pathname.startsWith("/rest/v1/")) throw new Error("non_isolated_request_forbidden");
  const target = `${ISOLATED_REST}/${url.pathname.slice("/rest/v1/".length)}${url.search}`;
  return realFetch(request ? new Request(target, request) : target, init);
}) as typeof fetch;
