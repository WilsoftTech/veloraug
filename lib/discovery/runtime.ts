import "server-only";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { notFound } from "next/navigation";
import { getAuthedClient } from "@/lib/auth";
import { fixtureSchema, fixturePorts } from "@/lib/discovery/fixtures";
import { openInbox } from "@/lib/discovery/store";
import { requireAdmin, type Reviewer } from "@/lib/discovery/model";
import { createReviewClient, type DiscoveryRpc } from "@/lib/discovery/database";

/**
 * Review modes. Both are off unless VELORA_DISCOVERY_MODE names one:
 * - fixture:  the E3.8 offline JSON inbox (refused in production);
 * - database: E3.8A review against Supabase. Every call runs as the signed-in
 *   reviewer's own session, and the database checks that account's capability
 *   (private.catalogue_reviewers). Approval and publication are not reachable
 *   from here: the page prepares the owner command (lib/discovery/owner-commands.ts).
 */
export type ReviewMode = "fixture" | "database";
export function reviewMode(env = process.env): ReviewMode | null {
  if (env.VELORA_DISCOVERY_MODE === "fixture" && env.NODE_ENV !== "production") return "fixture";
  if (env.VELORA_DISCOVERY_MODE === "database") return "database";
  return null;
}
export function assertOfflineReviewMode(env = process.env): void {
  if (env.NODE_ENV === "production" || env.VELORA_DISCOVERY_MODE !== "fixture") throw new Error("offline_review_disabled");
}
/** Fresh Auth-server user record, rather than a stale JWT role or user-editable metadata. */
export async function requireReviewAdmin(): Promise<Reviewer> {
  if (!reviewMode()) notFound();
  const authed = await getAuthedClient();
  if (!authed) notFound();
  const { data, error } = await authed.supabase.auth.getUser();
  const user = data.user;
  if (error || !user || user.id !== authed.user.id || user.is_anonymous || user.app_metadata?.role !== "admin") notFound();
  const reviewer = { id: user.id, admin: true };
  requireAdmin(reviewer);
  return reviewer;
}
export async function offlineReviewRuntime() {
  assertOfflineReviewMode();
  const directory = join(process.cwd(), ".velora-ingest", "discovery");
  const path = join(directory, "fixture.json");
  if ((await stat(path)).size > 2 * 1024 * 1024) throw new Error("fixture_size_limit");
  const fixture = fixtureSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const store = await openInbox(directory, process.cwd(), fixture.channelId);
  return { fixture, store, ports: fixturePorts(fixture) };
}
/** The reviewer's own-session client (no service-role key, no elevated identity). */
export async function databaseReviewClient() {
  if (reviewMode() !== "database") throw new Error("database_review_disabled");
  const authed = await getAuthedClient();
  if (!authed) notFound();
  // The generated Database type deliberately omits these RPCs; the database validates every argument.
  const supabase = authed.supabase as unknown as { rpc: DiscoveryRpc };
  return createReviewClient((fn, args) => supabase.rpc(fn, args));
}
