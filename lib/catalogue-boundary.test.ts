import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * B5 boundary: Supabase is the catalogue authority. No public route may reach
 * TMDB code except the temporary legacy My List lookup, and only through
 * lib/watchlist-actions.ts. This walks the real import graph from every route
 * entry file, so reintroducing a TMDB read on a catalogue path fails here.
 */

const ROOT = resolve(__dirname, "..");
const SOURCE_DIRS = ["app", "components", "lib", "types"];
const ROUTE_FILES = /(^|[\\/])(page|layout|route|loading|error|not-found|template|default)\.tsx?$/;

/** The only modules allowed under lib/tmdb/, with why each is allowed. */
const ALLOWED_TMDB_MODULES = {
  "lib/tmdb/client.ts": "server transport for enrichment, Phase C ingestion/admin and legacy lookup",
  "lib/tmdb/types.ts": "raw response shapes",
  "lib/tmdb/legacy-watchlist.ts": "TEMPORARY: describes legacy tmdb_id My List rows",
  "lib/tmdb/image-loader.ts": "image CDN for artwork paths stored on catalogue records (next.config.ts)",
  "lib/tmdb/ingestion-search.ts": "Phase C ingestion-only title search for the uploader CLI; never a catalogue search",
};
/** The one edge from app code into TMDB code. */
const ALLOWED_EDGE = { from: "lib/watchlist-actions.ts", to: "lib/tmdb/legacy-watchlist.ts" };

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const rel = (path: string) => relative(ROOT, path).split("\\").join("/");

function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(ROOT, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(from), specifier);
  else return null; // a package
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Unresolved import "${specifier}" in ${rel(from)}`);
}

const IMPORT = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(IMPORT)].flatMap((match) => {
    const target = resolveImport(file, match[1] ?? match[2] ?? match[3]);
    return target ? [rel(target)] : [];
  });
}

const files = SOURCE_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir)));
const graph = new Map(files.map((file) => [rel(file), importsOf(file)]));
const routes = [...graph.keys()].filter((file) => file.startsWith("app/") && ROUTE_FILES.test(file));

/** Every TMDB module reachable from a route, and the edge that entered it. */
function tmdbReach(skipAllowedEdge: boolean) {
  const entered = new Map<string, string>();
  const seen = new Set<string>();
  const stack = [...routes];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const target of graph.get(file) ?? []) {
      if (skipAllowedEdge && file === ALLOWED_EDGE.from && target === ALLOWED_EDGE.to) continue;
      if (target.startsWith("lib/tmdb/") && !file.startsWith("lib/tmdb/")) entered.set(target, file);
      stack.push(target);
    }
  }
  return entered;
}

describe("TMDB boundary (B5)", () => {
  it("finds the public routes it guards", () => {
    for (const route of ["app/page.tsx", "app/movies/page.tsx", "app/series/page.tsx", "app/search/page.tsx", "app/movies/[slug]/page.tsx", "app/series/[slug]/page.tsx", "app/vjs/[slug]/page.tsx", "app/[mediaType]/[id]/page.tsx"]) {
      expect(routes).toContain(route);
    }
  });

  it("no route reaches TMDB code except through the legacy My List edge", () => {
    expect(Object.fromEntries(tmdbReach(true))).toEqual({});
  });

  it("the legacy edge is the only way in, and it enters only the legacy module", () => {
    expect(Object.fromEntries(tmdbReach(false))).toEqual({ [ALLOWED_EDGE.to]: ALLOWED_EDGE.from });
  });

  it("only allowlisted modules exist under lib/tmdb/", () => {
    const modules = [...graph.keys()].filter((file) => file.startsWith("lib/tmdb/")).sort();
    expect(modules).toEqual(Object.keys(ALLOWED_TMDB_MODULES).sort());
  });

  it("the catalogue layer and catalogue components import nothing from TMDB", () => {
    for (const file of ["lib/catalogue.ts", "lib/browse.ts", "components/catalogue-browse.tsx", "components/hero.tsx", "components/movie-card.tsx"]) {
      expect(graph.get(file)?.filter((target) => target.startsWith("lib/tmdb/"))).toEqual([]);
    }
  });

  it("the ingestion TMDB search is used by no app, component or library module (uploader CLI only)", () => {
    const importers = [...graph].filter(([, targets]) => targets.includes("lib/tmdb/ingestion-search.ts")).map(([file]) => file);
    expect(importers).toEqual([]);
  });

  it("the TMDB API host appears only in the TMDB transport", () => {
    const offenders = files.map(rel).filter((file) => readFileSync(join(ROOT, file), "utf8").includes("api.themoviedb.org"));
    expect(offenders).toEqual(["lib/tmdb/client.ts"]);
  });
});
