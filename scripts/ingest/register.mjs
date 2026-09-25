// Runs the ingestion CLI on plain Node (native TypeScript type stripping) with
// no build step and no extra dependency. Two resolution rules only:
// - "@/..." maps to the project root, like the tsconfig "paths" alias;
// - "server-only" resolves to an empty module. The package throws outside a
//   React Server Components bundle, and this CLI is server-side by definition.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const EMPTY = "data:text/javascript,export {};";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: EMPTY, shortCircuit: true };
    if (specifier.startsWith("@/")) {
      const base = root + specifier.slice(2);
      for (const candidate of [`${base}.ts`, `${base}/index.ts`, base]) {
        if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true, format: candidate.endsWith(".ts") ? "module-typescript" : undefined };
      }
    }
    return nextResolve(specifier, context);
  },
});
