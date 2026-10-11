import { vjKey } from "@/lib/ingestion/normalize";
import type { KnownVj, VjResolution } from "@/types/ingestion";

/**
 * Two VJ keys name the same VJ by their opening characters: they agree on the
 * first four, or on the whole of the shorter key when it has only three
 * ("ice" and "icep"; "icep" and "icepnos"; never "iceman" and "icep").
 */
export function vjKeysAgree(a: string, b: string): boolean {
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  return shared >= 4 || (shared === 3 && shared === Math.min(a.length, b.length));
}

/**
 * Resolves parsed VJ text to an existing Velora VJ. It never creates a VJ: a
 * key must equal a VJ's name, slug or alias key exactly (case, spacing,
 * separators and a leading "VJ" ignored). Several VJs, or a VJ that is not
 * active, stop automatic processing. Near matches are returned only as
 * reviewer suggestions. `vjs` is read from public.vjs by the caller.
 *
 * `prefix` (channel discovery only, where a reviewer confirms the VJ): when no
 * key is equal, the one active VJ whose opening characters agree (vjKeysAgree)
 * resolves, marked `match: "prefix"`. Two such VJs stay ambiguous.
 */
export function resolveVj(vjText: string | null, vjs: readonly KnownVj[], options: { prefix?: boolean } = {}): VjResolution {
  const key = vjText === null ? "" : vjKey(vjText);
  if (!key) return { status: "missing" };

  const keysOf = (vj: KnownVj) => new Set([vj.name, vj.slug, ...(vj.aliases ?? [])].map(vjKey));
  const matches = vjs.filter((vj) => keysOf(vj).has(key));
  const active = matches.filter((vj) => vj.isActive);

  if (active.length === 1) return { status: "resolved", vjId: active[0].id, slug: active[0].slug };
  if (active.length > 1) return { status: "ambiguous", candidateIds: active.map((vj) => vj.id) };
  if (matches.length === 1) return { status: "inactive", vjId: matches[0].id, slug: matches[0].slug };
  if (matches.length > 1) return { status: "ambiguous", candidateIds: matches.map((vj) => vj.id) };

  if (options.prefix) {
    const near = vjs.filter((vj) => vj.isActive && [...keysOf(vj)].some((known) => vjKeysAgree(known, key)));
    if (near.length === 1) return { status: "resolved", vjId: near[0].id, slug: near[0].slug, match: "prefix" };
    if (near.length > 1) return { status: "ambiguous", candidateIds: near.map((vj) => vj.id) };
  }

  const suggestionIds = vjs
    .filter((vj) => [...keysOf(vj)].some((known) => known !== "" && (known.startsWith(key) || key.startsWith(known))))
    .map((vj) => vj.id);
  return { status: "unresolved", suggestionIds };
}
