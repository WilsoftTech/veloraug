import * as z from "zod";
import { MAX_SEARCH_LENGTH, MAX_SEARCH_RESULT_COUNT } from "@/lib/utils";

/**
 * Runtime validation for everything that arrives from a browser. Kept free of
 * Next.js imports so the same schemas can be reused by a future Expo client.
 */

const email = z.string().trim().max(254, "That email address is too long.").pipe(z.email("Enter a valid email address."));

export const signInSchema = z.object({
  email,
  password: z.string().min(1, "Enter your password.").max(72, "Use 72 characters or fewer."),
});

const displayName = z.string().trim().max(50, "Keep your name to 50 characters or fewer.");

export const profileSchema = z.object({ displayName });

export const signUpSchema = z.object({
  displayName,
  email,
  password: z.string().min(8, "Use at least 8 characters.").max(72, "Use 72 characters or fewer."),
});

/** Per-user cap on saved titles. Enforced by a database trigger; this mirrors it for the import payload. */
export const MAX_WATCHLIST_ITEMS = 500;

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** A saved title's identity (types/watchlist.ts): an internal catalogue id, or a legacy TMDB id. */
export const watchlistRefSchema = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("catalogue"), kind: z.enum(["movie", "series"]), id }),
  z.strictObject({ source: z.literal("tmdb"), mediaType: z.enum(["movie", "tv"]), id: id.max(2_147_483_647) }),
]);

export const watchlistRefListSchema = z.array(watchlistRefSchema).max(MAX_WATCHLIST_ITEMS);

/**
 * A search as the browser reports it. Deliberately shape-only: the database
 * (private.normalize_search_query) is the single authority on what counts as a
 * meaningful query, so nothing here trims, lowercases or filters. Strict, so a
 * payload carrying a user id or a timestamp is rejected rather than ignored.
 */
const searchQuery = z
  .string()
  .refine((value) => value.length > 0 && Array.from(value).length <= MAX_SEARCH_LENGTH, "Invalid search query.");

const searchScope = z.enum(["all", "movie", "tv"]);

export const recordSearchSchema = z.strictObject({
  query: searchQuery,
  scope: searchScope,
  // Caller-reported and untrusted: a display/analysis hint, never a fact.
  resultCount: z.number().int().min(0).max(MAX_SEARCH_RESULT_COUNT),
});

/** Identifies one history row to remove. The user comes from the session, never from here. */
export const searchHistoryKeySchema = z.strictObject({ query: searchQuery, scope: searchScope });

export type FieldErrors = Record<string, string[] | undefined>;

export function fieldErrors(error: z.ZodError): FieldErrors {
  return z.flattenError(error).fieldErrors;
}
