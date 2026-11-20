export const POSTER_MAX_BYTES = 5 * 1024 * 1024;
export const POSTER_WIDTHS = [185, 342, 500, 780, 1200] as const;
export const POSTER_PATH = /^\/posters\/([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.webp$/;
export function posterWidth(width: number): number { return POSTER_WIDTHS.find(size => size >= width) ?? 1200; }
export function isPosterPath(path: string): boolean { return POSTER_PATH.test(path); }
