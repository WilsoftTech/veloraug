import { vjKey } from "@/lib/ingestion/normalize";
import type { KnownVj, VjResolution } from "@/types/ingestion";

/**
 * Resolves parsed VJ text to an existing Velora VJ. It never creates a VJ and
 * never guesses: a key must equal a VJ's name, slug or alias key exactly
 * (case, spacing, separators and a leading "VJ" ignored). Several VJs, or a
 * VJ that is not active, stop automatic processing. Near matches are returned
 * only as reviewer suggestions. `vjs` is read from public.vjs by the caller.
 */
export function resolveVj(vjText: string | null, vjs: readonly KnownVj[]): VjResolution {
  const key = vjText === null ? "" : vjKey(vjText);
  if (!key) return { status: "missing" };

  const keysOf = (vj: KnownVj) => new Set([vj.name, vj.slug, ...(vj.aliases ?? [])].map(vjKey));
  const matches = vjs.filter((vj) => keysOf(vj).has(key));
  const active = matches.filter((vj) => vj.isActive);

  if (active.length === 1) return { status: "resolved", vjId: active[0].id, slug: active[0].slug };
  if (active.length > 1) return { status: "ambiguous", candidateIds: active.map((vj) => vj.id) };
  if (matches.length === 1) return { status: "inactive", vjId: matches[0].id, slug: matches[0].slug };
  if (matches.length > 1) return { status: "ambiguous", candidateIds: matches.map((vj) => vj.id) };

  const suggestionIds = vjs
    .filter((vj) => [...keysOf(vj)].some((known) => known !== "" && (known.startsWith(key) || key.startsWith(known))))
    .map((vj) => vj.id);
  return { status: "unresolved", suggestionIds };
}
