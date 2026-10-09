import "server-only";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { notFound } from "next/navigation";
import { getAuthedClient } from "@/lib/auth";
import { fixtureSchema, fixturePorts } from "@/lib/discovery/fixtures";
import { openInbox } from "@/lib/discovery/store";
import { requireAdmin, type Reviewer } from "@/lib/discovery/model";

export function assertOfflineReviewMode(env = process.env): void {
  if (env.NODE_ENV === "production" || env.VELORA_DISCOVERY_MODE !== "fixture") throw new Error("offline_review_disabled");
}
/** Fresh Auth-server user record, rather than a stale JWT role or user-editable metadata. */
export async function requireReviewAdmin(): Promise<Reviewer> {
  try { assertOfflineReviewMode(); } catch { notFound(); }
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
