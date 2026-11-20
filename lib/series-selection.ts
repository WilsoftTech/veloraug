import type { Episode, Season } from "@/types/catalogue";

/** A search-param value as Next.js passes it. */
type ParamValue = string | string[] | undefined;

export interface EpisodeSelection {
  season: Season;
  /** Null only for a season with no available episode. */
  episode: Episode | null;
  /** The URL that states this selection; differs from the request when the request named something absent. */
  href: string;
  /** The request named a season or episode, and it is not what was selected. */
  corrected: boolean;
}

/** Season 0 holds specials, so zero is a valid number. Anything but plain digits is ignored. */
function parseNumber(value: ParamValue): number | null {
  return typeof value === "string" && /^\d{1,4}$/.test(value) ? Number(value) : null;
}

export function seasonLabel(season: Pick<Season, "title" | "seasonNumber">) {
  return season.title ?? (season.seasonNumber === 0 ? "Specials" : `Season ${season.seasonNumber}`);
}

export function episodeLabel(episode: Pick<Episode, "episodeNumber" | "title">) {
  return episode.title ? `E${episode.episodeNumber} · ${episode.title}` : `Episode ${episode.episodeNumber}`;
}

/** The shareable address of one season (its first episode) or one episode of a series. */
export function seriesEpisodeHref(slug: string, seasonNumber: number, episodeNumber?: number) {
  const params = new URLSearchParams({ season: String(seasonNumber) });
  if (episodeNumber !== undefined) params.set("episode", String(episodeNumber));
  return `/series/${slug}?${params}`;
}

/**
 * Resolves `?season=&episode=` against the published seasons. With no request it picks the first
 * regular season (specials only when nothing else exists) and its first episode. An unknown season
 * falls back the same way; an unknown episode falls back to the first episode of the named season.
 */
export function selectEpisode(slug: string, seasons: Season[], query: { season?: ParamValue; episode?: ParamValue }): EpisodeSelection | null {
  if (seasons.length === 0) return null;
  const requestedSeason = parseNumber(query.season);
  const requestedEpisode = parseNumber(query.episode);
  const named = seasons.find((season) => season.seasonNumber === requestedSeason);
  const season = named ?? seasons.find((season) => season.seasonNumber > 0) ?? seasons[0];
  const episode = (named && season.episodes.find((item) => item.episodeNumber === requestedEpisode)) || season.episodes[0] || null;
  // `?season=N` alone is a complete address (its first episode); a named episode needs its season.
  const corrected = (query.season !== undefined && requestedSeason !== season.seasonNumber)
    || (query.episode !== undefined && (named === undefined || requestedEpisode !== episode?.episodeNumber));
  return { season, episode, href: seriesEpisodeHref(slug, season.seasonNumber, episode?.episodeNumber), corrected };
}
