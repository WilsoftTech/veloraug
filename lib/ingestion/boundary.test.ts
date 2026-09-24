import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase C boundary: the ingestion domain is framework-independent and
 * server/worker-only. It imports no Next.js, React, Supabase, TMDB transport
 * or Telegram client, reads no environment variables, and no app, component
 * or public data-layer module imports it (so nothing here can reach a client
 * bundle or a public route).
 */

const ROOT = resolve(__dirname, "../..");
const MODULES = readdirSync(join(ROOT, "lib/ingestion")).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
const source = (name: string) => readFileSync(join(ROOT, "lib/ingestion", name), "utf8");
const specifiers = (text: string) => [...text.matchAll(/from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1] ?? match[2]);

function filesUnder(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [],
  );
}

describe("ingestion boundary (C1)", () => {
  it("has the expected pure modules", () => {
    expect(MODULES.sort()).toEqual(["duplicates.ts", "fingerprint.ts", "match.ts", "normalize.ts", "parser.ts", "plan.ts", "state.ts", "telegram.ts", "vj.ts"]);
  });

  it("imports only other ingestion modules, domain types, zod and node:crypto", () => {
    const allowed = /^(?:@\/lib\/ingestion\/|@\/types\/(?:ingestion|catalogue)$|zod$|node:crypto$)/;
    for (const name of MODULES) {
      expect(specifiers(source(name)).filter((specifier) => !allowed.test(specifier)), name).toEqual([]);
    }
  });

  it("reads no environment, secrets or network", () => {
    for (const name of MODULES) {
      expect(source(name), name).not.toMatch(/process\.env|fetch\(|api\.telegram\.org|api\.themoviedb\.org|"use client"/);
    }
  });

  it("is not imported by app code, components or the public data layer", () => {
    const importers = ["app", "components"].flatMap(filesUnder).concat(["lib/catalogue.ts", "lib/browse.ts", "lib/utils.ts"])
      .filter((file) => specifiers(readFileSync(join(ROOT, file), "utf8")).some((specifier) => specifier.includes("ingestion")));
    expect(importers).toEqual([]);
  });
});
