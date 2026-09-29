import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * E1.2 boundary: the media gateway is a separate long-running service. Its core
 * (lib/media-gateway) depends only on Node built-ins and the pure E1.1 range
 * planner, and nothing in the Next.js application imports it or the service's
 * MTProto/Postgres adapters, so neither can reach a browser or server bundle.
 */
const ROOT = resolve(__dirname, "../..");
const rel = (path: string) => relative(ROOT, path).split("\\").join("/");

function files(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules") return [];
    if (statSync(path).isDirectory()) return files(path, pattern);
    return pattern.test(name) ? [path] : [];
  });
}

const IMPORT = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;
const importsOf = (file: string) => [...readFileSync(file, "utf8").matchAll(IMPORT)].map((m) => m[1] ?? m[2] ?? m[3]);

describe("media gateway boundary", () => {
  it("keeps the gateway core free of frameworks and third-party packages", () => {
    const core = files(join(ROOT, "lib/media-gateway"), /\.ts$/).filter((f) => !/\.test\.ts$|test-fakes\.ts$/.test(f));
    expect(core.length).toBeGreaterThan(5);
    for (const file of core) {
      for (const specifier of importsOf(file)) {
        const allowed = specifier.startsWith("node:") || specifier.startsWith("@/lib/media-gateway/") || specifier === "@/lib/telegram/mtproto-range";
        expect(allowed, `${rel(file)} imports ${specifier}`).toBe(true);
      }
    }
  });

  /**
   * E2 exception: the application's stream-capability issuer (lib/playback)
   * shares the token contract and the rate-limit primitive, so there is one
   * signing implementation. Both are pure (next test); nothing else crosses.
   */
  const SHARED_WITH_ISSUER = ["@/lib/media-gateway/token", "@/lib/media-gateway/limits"];

  it("is never imported by the Next.js application, except the shared token contract in lib/playback", () => {
    const appFiles = ["app", "components", "lib", "types", "proxy.ts"].flatMap((entry) => {
      const path = join(ROOT, entry);
      if (!existsSync(path)) return [];
      return statSync(path).isDirectory() ? files(path, /\.(ts|tsx|mts)$/) : [path];
    });
    for (const file of appFiles.filter((f) => !rel(f).startsWith("lib/media-gateway/"))) {
      const issuer = rel(file).startsWith("lib/playback/");
      for (const specifier of importsOf(file)) {
        if (issuer && SHARED_WITH_ISSUER.includes(specifier)) continue;
        expect(/media-gateway|services\/|@mtcute|^postgres$/.test(specifier), `${rel(file)} imports ${specifier}`).toBe(false);
      }
    }
  });

  it("keeps the modules shared with the issuer free of anything but Node crypto and the gateway error model", () => {
    const allowed: Record<string, string[]> = {
      "lib/media-gateway/token.ts": ["node:crypto"],
      "lib/media-gateway/limits.ts": ["@/lib/media-gateway/errors"],
      "lib/media-gateway/errors.ts": [],
    };
    for (const [file, imports] of Object.entries(allowed)) expect(importsOf(join(ROOT, file)), file).toEqual(imports);
  });

  it("keeps MTProto and Postgres packages out of the application's dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { dependencies?: object; devDependencies?: object };
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(names.filter((name) => /mtcute|^telegram$|teleproto|^tdl|^postgres$|^pg$/.test(name))).toEqual([]);
  });

  it("reads no gateway or media-reader secret from NEXT_PUBLIC_ variables", () => {
    const sources = files(join(ROOT, "lib/media-gateway"), /\.ts$/).concat(files(join(ROOT, "services"), /\.mts$/));
    for (const file of sources.filter((f) => !/\.test\.ts$/.test(f))) {
      expect(readFileSync(file, "utf8"), rel(file)).not.toMatch(/env(\.|\[\s*["'`])NEXT_PUBLIC_|["'`]NEXT_PUBLIC_[A-Z_]*["'`]/);
    }
  });
});
