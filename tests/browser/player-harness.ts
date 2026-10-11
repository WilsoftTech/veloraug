import { createServer as createViteServer } from "vite";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { createStreamTokenHandler } from "@/lib/playback/stream-token";
import { GatewayError } from "@/lib/media-gateway/errors";
import { FIXTURES, startHarness } from "./harness";

/** Isolated actual-player host, actual issuer/gateway, synthetic identity and local fixture media. */
export async function startPlayerHarness() {
  const state = { signedIn: true, entitled: true, published: true, expiredOnce: false, gatewayUnavailable: false };
  const requests: { operation: string; versionId: number }[] = [];
  let gatewayOrigin = "";
  const handler = (operation: "stream" | "download") => createStreamTokenHandler({
    accountsConfigured: () => true,
    currentUser: async () => state.signedIn ? { id: "00000000-0000-4000-8000-000000000061", email: null } : null,
    decide: async (user, id) => {
      requests.push({ operation, versionId: id });
      return !user ? { allowed: false, reason: "authentication_required" } : !state.entitled ? { allowed: false, reason: "not_entitled" } : !state.published ? { allowed: false, reason: "unavailable" } : { allowed: true, movieVersionId: id, subject: user.id };
    },
    loadConfig: () => ({ secret: new Uint8Array(32).fill(7), gatewayOrigin }),
    now: () => {
      if (operation === "download" && state.expiredOnce) return Date.now() - 601_000;
      return Date.now();
    },
  }, operation);
  const stream = handler("stream"); const download = handler("download");
  const vite = await createViteServer({
    configFile: false, envDir: false,
    resolve: { alias: [
      { find: "@/lib/session", replacement: "fixture-session" },
      { find: "next/link", replacement: "fixture-link" },
      { find: "@", replacement: resolve(__dirname, "../..") },
    ] },
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "lucide-react"], exclude: ["fixture-link", "fixture-session"] },
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
    plugins: [{ name: "isolated-player-host",
      resolveId(id) { if (id === "fixture-session") return "\0fixture-session"; if (id === "fixture-link") return "\0fixture-link"; },
      load(id) {
        if (id === "\0fixture-session") return `import { useSyncExternalStore } from 'react'; export function useSession() { return useSyncExternalStore((notify) => { window.addEventListener('fixture-session', notify); return () => window.removeEventListener('fixture-session', notify); }, () => window.fixtureSignedIn ? 'signed-in' : 'signed-out', () => 'unknown'); }`;
        if (id === "\0fixture-link") return `import { createElement } from 'react'; export default function Link(props) { return createElement('a', props); }`;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const path = new URL(req.url ?? "/", "http://fixture.invalid");
          if (/^\/api\/media\/(stream|download)-token$/.test(path.pathname)) {
            let text = ""; for await (const chunk of req) text += String(chunk);
            const post = path.pathname.includes("download") ? download : stream;
            const result = await post(new Request(`${origin}${path.pathname}`, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: text }));
            if (path.pathname.includes("download")) state.expiredOnce = false;
            res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(await result.text()); return;
          }
          if (path.pathname !== "/fixture") return next();
          const ids = (path.searchParams.get("versions") ?? "1,4").split(",").map(Number);
          const versions = ids.map((id) => {
            const file = FIXTURES.find((item) => item.id === id)!;
            return { id, label: `VJ Fixture ${id}`, profile: path.searchParams.has("legacy") ? null : {
              container: path.searchParams.has("unsupported") ? "other" : file.container,
              videoCodec: file.video, audioCodec: file.audio[0], startupWarning: file.fastStart === false,
            } };
          });
          const page = await server.transformIndexHtml("/fixture", `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated player</title></head><body><div id="root"></div><script>window.fixtureVersions=${JSON.stringify(versions)};window.fixtureSignedIn=${state.signedIn};</script><script type="module" src="/tests/browser/player-fixture.tsx"></script></body></html>`);
          res.setHeader("content-type", "text/html"); res.end(page);
        });
      },
    }],
  });
  // No .env loading or Next.js service startup. Only this disposable loopback fixture host.
  await vite.listen();
  const origin = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
  const gateway = await startHarness({ downloads: true, allowedOrigins: [origin],
    downloadAccess: () => state.signedIn && state.entitled && state.published,
    beforeRead: () => {
      if (state.gatewayUnavailable) throw new GatewayError("telegram_unavailable");
    },
  });
  gatewayOrigin = gateway.origin;
  return { origin, gateway, state, requests, async close() {
    if (vite.httpServer && "closeAllConnections" in vite.httpServer) vite.httpServer.closeAllConnections();
    await vite.close(); await gateway.close();
  } };
}
