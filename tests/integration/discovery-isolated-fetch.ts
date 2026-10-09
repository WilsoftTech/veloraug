import { execFileSync } from "node:child_process";

// Reach real PostgREST inside an internal-only Docker network through docker exec.
// Docker Desktop cannot publish this internal network's port. No fake catalogue responses.
if (process.env.VELORA_E38_ISOLATED_TESTS !== "true") throw new Error("isolated_tests_only");
if (execFileSync("docker", ["inspect", "velora-e38-offline", "--format", "{{.Internal}}"], { encoding: "utf8" }).trim() !== "true") throw new Error("network_must_be_internal");
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input));
  const method = init?.method ?? request?.method ?? "GET";
  const readRpc = method === "POST" && url.pathname === "/rest/v1/rpc/trending_searches";
  if (url.origin !== "http://127.0.0.1:54329" || !url.pathname.startsWith("/rest/v1/") || (method !== "GET" && !readRpc)) throw new Error("non_isolated_catalogue_read_forbidden");
  const target = `http://127.0.0.1:3000/${url.pathname.slice("/rest/v1/".length)}${url.search}`;
  const args = ["exec", "velora-e38-db", "curl", "-sS", "--globoff", "--max-time", "5", "-w", "\n%{http_code}"];
  if (readRpc) {
    const body = typeof init?.body === "string" ? init.body : await request?.text();
    const value = JSON.parse(body ?? "{}");
    if (Object.keys(value).join() !== "p_limit" || !Number.isSafeInteger(value.p_limit) || value.p_limit < 1 || value.p_limit > 100) throw new Error("invalid_read_rpc");
    args.push("-H", "content-type: application/json", "--data", JSON.stringify(value));
  }
  const response = execFileSync("docker", [...args, target], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const at = response.lastIndexOf("\n");
  return new Response(response.slice(0, at), { status: Number(response.slice(at + 1)), headers: { "content-type": "application/json" } });
}) as typeof fetch;
