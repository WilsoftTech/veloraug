/**
 * Text normalization shared by the filename parser, VJ resolution and TMDB
 * matching. Pure and deterministic.
 */

/** Lowercase, accents and punctuation removed, `&` read as "and", single spaces. */
export function normalizeTitle(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Comparison key for a VJ name, slug or alias: normalized, a leading "VJ"
 * word dropped, spaces removed. "VJ Junior", "vj-junior", "Junior" and
 * "VJ.JUNIOR" all give "junior"; "Ice P" and "IceP" both give "icep".
 */
export function vjKey(text: string): string {
  return normalizeTitle(text)
    .replace(/^vj(?: |$)/, "")
    .replace(/ /g, "");
}

/**
 * Filename separators (dots, underscores, repeated whitespace) become single
 * spaces. Hyphens inside words ("Spider-Man") are kept; a hyphen next to a
 * space is a segment separator and becomes " - ".
 */
export function unifySeparators(text: string): string {
  return text
    .replace(/[._]+/g, " ")
    .replace(/(?:^|\s)-+|-+(?:\s|$)/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
}
