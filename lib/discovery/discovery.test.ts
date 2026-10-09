import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { openInbox } from "./store";
import { detectDocument, parseDocument, mediaKey, receive } from "./events";
import { fixtureSchema, fixturePorts } from "./fixtures";
import { inspectNext, blockers, type InspectionPorts } from "./pipeline";
import { decideReview, publishReviewed, approvedPublicationScript } from "./review";
import { runReplay, replayProvider, reconcile } from "./worker";
import type { InboxStore, ReviewCandidate } from "./model";

const channel = -1009990001112;
const actor = { id: "synthetic-admin", admin: true };
const instant = new Date("2026-10-09T12:00:00.000Z");
const now = () => instant;
const signal = () => new AbortController().signal;
const post = (id = 1, message = 10, unique = "doc1", name = "Example.Movie.2024.VJ.Test.mp4", caption?: string) => ({ update_id: id, channel_post: { message_id: message, date: 1791504000, chat: { id: channel, type: "channel" }, document: { file_id: "DO-NOT-PERSIST", file_unique_id: unique, file_name: name, mime_type: "video/mp4", file_size: 1024 }, ...(caption ? { caption } : {}) } });
let directory: string, store: InboxStore, ports: InspectionPorts;
const source = `sf1-${"a".repeat(64)}`;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "velora-e38-"));
  store = await openInbox(directory, process.cwd(), channel);
  const fixture = fixtureSchema.parse(JSON.parse(await readFile("scripts/discovery/example.json", "utf8")));
  ports = fixturePorts(fixture);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("offline_test_network_forbidden"); }));
});
afterEach(async () => { vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });
async function detect(updates: unknown[] = [post()]) { return store.transaction((inbox) => receive(inbox, updates, instant.toISOString())); }
async function candidate(): Promise<ReviewCandidate> { return Object.values((await store.read()).candidates)[0]; }
async function inspected(ready = false, existing = false) {
  if (ready) ports.media = async (event) => ({ duplicateOf: null, source: existing ? { fingerprint: source, mediaKey: mediaKey(event), evaluatedTmdbId: 900001, evaluatedVjId: 9001 } : null, evidence: { mediaKey: mediaKey(event), accessible: true, container: true, gateway: true, browser: true, checkedAt: instant.toISOString(), reference: "synthetic-proof" } });
  await detect(); await inspectNext(store, ports, now);
  return candidate();
}
async function approve(existing = true) {
  let item = await inspected(true, existing);
  item = await decideReview(store, actor, item.id, item.revision, { kind: "correct", fields: { title: "Example Movie", year: 2024, tmdbId: 900001, vjId: 9001 } }, await ports.vjs(), instant);
  item = await decideReview(store, actor, item.id, item.revision, { kind: "rights", reference: "synthetic-license-test" }, await ports.vjs(), instant);
  return decideReview(store, actor, item.id, item.revision, { kind: "approve" }, await ports.vjs(), instant);
}

describe("E3.8 offline detection and durable inbox", () => {
  it("detects a valid document, strips bot file ids and records all durability fields", async () => {
    await detect(); const inbox = await store.read(); const item = await candidate();
    expect(item.status).toBe("detected"); expect(inbox.checkpoint).toBe(1);
    expect(item.event.media.size).toBe(1024); expect(item.attempts).toBe(0);
    expect(await readFile(join(directory, "discovery-inbox.json"), "utf8")).not.toContain("DO-NOT-PERSIST");
    expect(inbox.deliveries["1"]).toMatchObject({ count: 1, firstSeen: instant.toISOString(), lastSeen: instant.toISOString() });
  });
  it("duplicate update deliveries produce one candidate and event", async () => {
    await detect(); expect((await detect()).duplicates).toBe(1);
    const inbox = await store.read(); expect(Object.keys(inbox.events)).toHaveLength(1); expect(Object.keys(inbox.candidates)).toHaveLength(1); expect(inbox.deliveries["1"].count).toBe(2);
  });
  it("redacts links and credential-shaped text while retaining source claims", async () => {
    await detect([post(1, 10, "doc", undefined, `Example 2024 VJ Test https://example.invalid/play?token=secret 123456789:${"x".repeat(35)}\nvelora-src:${source}`)]);
    const text = await readFile(join(directory, "discovery-inbox.json"), "utf8");
    expect(text).not.toContain("token=secret"); expect(text).not.toContain("x".repeat(35)); expect((await candidate()).event.media.caption).toContain(source);
  });
  it("an edit removing the document invalidates approval without claiming channel deletion", async () => {
    const item = await approve(); const original = post().channel_post;
    const withoutDocument: Omit<typeof original, "document"> & { document?: typeof original.document } = { ...original };
    delete withoutDocument.document;
    await detect([{ update_id: 3, edited_channel_post: { ...withoutDocument, edit_date: 1791504001, text: "Unavailable" } }]);
    expect(await candidate()).toMatchObject({ status: "blocked", error: "edited_media_unavailable", approval: null, revision: item.revision + 1 });
  });
  it("replacement edits cannot disguise a repost as another approvable candidate", async () => {
    await detect([post(), post(2, 11, "doc2")]);
    await detect([{ update_id: 3, edited_channel_post: { ...post(2, 11).channel_post, edit_date: 1791504001 } }]);
    expect(Object.values((await store.read()).candidates)[1].status).toBe("duplicate");
  });
  it("same document repost is a duplicate even if the VJ caption differs", async () => {
    await detect([post(), post(2, 11, "doc1", "Example.Movie.2024.VJ.Other.mp4")]);
    expect(Object.values((await store.read()).candidates).map((item) => item.status)).toEqual(["detected", "duplicate"]);
  });
  it("another document and VJ stays a distinct version candidate", async () => {
    await detect([post(), post(2, 11, "doc2", "Example.Movie.2024.VJ.Other.mp4")]);
    expect(Object.values((await store.read()).candidates).map((item) => item.status)).toEqual(["detected", "detected"]);
  });
  it("caption edits fence old processing and invalidate approval", async () => {
    const item = await approve();
    await detect([{ update_id: 3, edited_channel_post: { ...post().channel_post, edit_date: 1791504001, caption: "Example Movie (2024)\nVJ Test" } }]);
    const next = await candidate(); expect(next.revision).toBe(item.revision + 1); expect(next.approval).toBeNull(); expect(next.rights).toBeNull(); expect(next.evidence).toBeNull();
  });
  it("published and rejected candidates cannot be silently changed by edits", async () => {
    const item = await approve();
    await publishReviewed(store, actor, item.id, item.revision, { publish: async () => ({ movieSlug: "synthetic-example", versionId: 999 }) }, now);
    await detect([{ update_id: 2, edited_channel_post: { ...post().channel_post, edit_date: 1791504001, caption: "Changed" } }]);
    expect(await candidate()).toMatchObject({ status: "blocked", error: "published_message_changed", publication: { versionId: 999 } });
  });
  it("out-of-order posts and edits never overwrite newer evidence", async () => {
    await detect([{ update_id: 3, edited_channel_post: { ...post().channel_post, edit_date: 1791504002, caption: "New" } }, post(2)]);
    expect((await candidate()).event.media.caption).toBe("New"); expect((await store.read()).checkpoint).toBe(3);
    expect(Object.values((await store.read()).events).map((event) => event.status)).toEqual(["pending", "superseded"]);
  });
  it("ignores Series channel, text, recovery markers and video messages", async () => {
    const other = post(); other.channel_post.chat.id = channel - 1;
    const text = { update_id: 3, channel_post: { message_id: 15, date: 1791504000, chat: { id: channel, type: "channel" }, text: "Example Movie" } };
    await detect([other, post(2, 12, "marker", undefined, "velora-recovery:v1 Movie 2024 VJ Test"), text]);
    expect(Object.keys((await store.read()).candidates)).toHaveLength(0); expect((await store.read()).checkpoint).toBe(3);
  });
  it("a crash before persistence leaves the event recoverable and unacknowledged", async () => {
    const acknowledge = vi.fn(); const realTransaction = store.transaction;
    store.transaction = async () => { throw new Error("disk_unavailable"); };
    await expect(runReplay(store, { ...replayProvider([post()]), acknowledge }, ports, { now, signal: signal(), paceMs: 0 })).rejects.toThrow("disk_unavailable");
    expect(acknowledge).not.toHaveBeenCalled(); store.transaction = realTransaction;
    expect((await detect()).detected).toBe(1);
  });
  it("restart after persistence replays safely and recovers unfinished processing", async () => {
    await detect(); store = await openInbox(directory, process.cwd(), channel);
    await runReplay(store, replayProvider([post()]), ports, { now, signal: signal(), paceMs: 0 });
    expect(Object.keys((await store.read()).candidates)).toHaveLength(1); expect((await candidate()).status).toBe("awaiting_identity");
  });
  it("transaction failure rolls back events and checkpoint together", async () => {
    await expect(store.transaction((inbox) => { receive(inbox, [post()], instant.toISOString()); throw new Error("crash"); })).rejects.toThrow();
    expect((await store.read()).checkpoint).toBeNull(); expect(Object.keys((await store.read()).events)).toHaveLength(0);
  });
  it("conflicting payload for one update refuses checkpoint advancement", async () => {
    await detect(); await expect(detect([post(1, 10, "changed")])).rejects.toThrow("update_payload_conflict");
    expect((await candidate()).event.media.uniqueId).toBe("doc1");
  });
  it("store corruption and channel mismatch fail closed", async () => {
    await detect(); await expect((await openInbox(directory, process.cwd(), channel - 1)).read()).rejects.toThrow("inbox_channel_mismatch");
    await writeFile(join(directory, "discovery-inbox.json"), "{"); await expect(store.read()).rejects.toThrow();
  });
});
describe("parsing, matching, VJs and readiness", () => {
  it.each([ ["Call.of.Heroes.2016.VJ.Ice.P.mp4", "Call of Heroes", 2016, "Ice P"], ["The Killer (2024) - VJ Ice P.mp4", "The Killer", 2024, "Ice P"], ["100 Yards 2023.mp4", "100 Yards", 2023, null] ])("reuses deterministic parsing for %s", (name, title, year, vj) => {
    const event = detectDocument(post(1, 10, "doc", name), channel).event!; expect(parseDocument(event)).toMatchObject({ title, year, vjText: vj });
  });
  it("caption-only title/year/VJ is supported, fingerprint and external id remain untrusted claims", () => {
    const update = post(1, 10, "doc", undefined, `Movie Title | 2016 | VJ Ice P\nvelora-src:${source}\ntmdb:movie:123`);
    delete (update.channel_post.document as { file_name?: string }).file_name;
    expect(parseDocument(detectDocument(update, channel).event!)).toMatchObject({ title: "Movie Title", year: 2016, vjText: "Ice P", claimedFingerprint: source, externalId: "123" });
  });
  it("exact title/year and active VJ are proposed, never approved or ready automatically", async () => {
    const item = await inspected(); expect(item).toMatchObject({ tmdbId: 900001, vjId: 9001, identity: "proposed", status: "awaiting_identity", evidence: null, rights: null, approval: null });
  });
  it("existing catalogue identity is resolved before TMDB search; another VJ is a new version", async () => {
    ports.catalogue = async () => [{ movieId: 7, tmdbId: 900001, title: "Example Movie", originalTitle: null, year: 2024, mediaType: "movie", vjIds: [8000] }];
    ports.search = vi.fn(async () => { throw new Error("must_not_search"); });
    expect(await inspected()).toMatchObject({ movieId: 7, relation: "new_vj" }); expect(ports.search).not.toHaveBeenCalled();
  });
  it("same movie/VJ with different media is replacement review, never overwrite", async () => {
    ports.catalogue = async () => [{ movieId: 7, tmdbId: 900001, title: "Example Movie", originalTitle: null, year: 2024, mediaType: "movie", vjIds: [9001] }];
    expect(await inspected()).toMatchObject({ relation: "replacement" }); expect(blockers(await candidate())).toContain("existing_version_replacement_requires_separate_workflow");
  });
  it("unknown or inactive VJ remains unresolved", async () => {
    ports.vjs = async () => [{ id: 9001, name: "Test", slug: "test", isActive: false }]; expect((await inspected()).vjId).toBeNull();
  });
  it("namesakes remain ambiguous instead of choosing first TMDB result", async () => {
    ports.search = async () => [900001, 900002].map((tmdbId) => ({ tmdbId, title: "Example Movie", originalTitle: null, year: 2024, mediaType: "movie" }));
    expect(await inspected()).toMatchObject({ identity: "ambiguous", status: "awaiting_identity" });
  });
  it("TMDB unavailable retains a retryable candidate without provider secrets", async () => {
    ports.search = async () => { throw new Error("secret-url-token"); };
    expect(await inspected()).toMatchObject({ status: "failed", error: "inspection_provider_failed", attempts: 1 });
    expect(await readFile(join(directory, "discovery-inbox.json"), "utf8")).not.toContain("secret-url-token");
  });
  it("unsupported formats and episode documents are permanently blocked", async () => {
    await detect([post(1, 10, "doc", "Movie.exe"), post(2, 11, "doc2", "Example.S01E01.VJ.Test.mp4")]);
    await inspectNext(store, ports, now); await inspectNext(store, ports, now);
    expect(Object.values((await store.read()).candidates).map((item) => item.status)).toEqual(["blocked", "blocked"]);
  });
  it("verification for another media identity cannot confer readiness", async () => {
    ports.media = async () => ({ duplicateOf: null, source: null, evidence: { mediaKey: "a".repeat(64), container: true, gateway: true, browser: true, accessible: true, checkedAt: instant.toISOString(), reference: "synthetic-wrong-proof" } });
    expect((await inspected()).evidence).toBeNull();
  });
});
describe("review, authorization and existing publication boundary", () => {
  it("missing rights and unknown media block approval", async () => {
    const item = await inspected();
    await expect(decideReview(store, actor, item.id, item.revision, { kind: "approve" }, await ports.vjs(), instant)).rejects.toThrow("rights_clearance_required");
    expect(blockers(await candidate())).toContain("media_verification_required");
  });
  it("unauthorized reviewer cannot correct, clear rights, approve, reject or publish", async () => {
    const item = await inspected();
    for (const command of [{ kind: "approve" }, { kind: "rights", reference: "x" }, { kind: "reject" }] as const) await expect(decideReview(store, { id: "ordinary-user", admin: false }, item.id, item.revision, command, [], instant)).rejects.toThrow("admin_required");
    const publish = vi.fn(); await expect(publishReviewed(store, { id: "ordinary-user", admin: false }, item.id, item.revision, { publish }, now)).rejects.toThrow("admin_required"); expect(publish).not.toHaveBeenCalled();
  });
  it("stale corrections and approvals cannot overwrite newer review data", async () => {
    const item = await approve(); await expect(decideReview(store, actor, item.id, item.revision - 1, { kind: "approve" }, [], instant)).rejects.toThrow("stale_review");
  });
  it("duplicate approval is idempotent and audit identifies the real supplied reviewer", async () => {
    const item = await approve(); const again = await decideReview(store, actor, item.id, item.revision, { kind: "approve" }, [], instant);
    expect(again.audit).toEqual(item.audit); expect(again.approval).toEqual({ actor: actor.id, at: instant.toISOString(), revision: item.revision });
  });
  it("unverified direct channel uploads cannot fake the uploader fingerprint", async () => {
    const item = await approve(false); expect(item.uploaderSource).toBeNull(); expect(() => approvedPublicationScript(item)).toThrow("channel_publication_extension_required");
  });
  it("successful isolated publication calls existing owner functions, never raw catalogue writes", async () => {
    const item = await approve(); const publish = vi.fn(async (script: string) => {
      expect(script).toContain("private.catalogue_approve_movie_match"); expect(script).toContain("private.catalogue_publish_movie"); expect(script).not.toMatch(/insert into public.movies/i);
      return { movieSlug: "synthetic-example", versionId: 999 };
    });
    const done = await publishReviewed(store, actor, item.id, item.revision, { publish }, now);
    expect(done.status).toBe("published"); await publishReviewed(store, actor, item.id, item.revision, { publish }, now); expect(publish).toHaveBeenCalledTimes(1);
  });
  it("concurrent publish requests invoke one owner transaction", async () => {
    const item = await approve(); let finish!: () => void; let started!: () => void;
    const gate = new Promise<void>((done) => { finish = done; }); const claimed = new Promise<void>((done) => { started = done; });
    const publish = vi.fn(async () => { started(); await gate; return { movieSlug: "synthetic-example", versionId: 999 }; });
    const first = publishReviewed(store, actor, item.id, item.revision, { publish }, now); await claimed;
    await expect(publishReviewed(store, actor, item.id, item.revision, { publish }, now)).rejects.toThrow("publication_in_progress"); finish(); await first;
    expect(publish).toHaveBeenCalledTimes(1);
  });
  it("publication failure stays uncertain and cannot silently resend or reapprove", async () => {
    const item = await approve(); const publish = vi.fn(async () => { throw new Error("database-secret"); });
    await expect(publishReviewed(store, actor, item.id, item.revision, { publish }, now)).rejects.toThrow("publication_uncertain");
    expect((await candidate()).status).toBe("publishing");
    await expect(publishReviewed(store, actor, item.id, item.revision, { publish }, now)).rejects.toThrow("publication_in_progress"); expect(publish).toHaveBeenCalledTimes(1);
  });
  it("rejected candidates cannot be republished or reopened by an edit", async () => {
    const item = await inspected(); await decideReview(store, actor, item.id, item.revision, { kind: "reject" }, [], instant);
    await expect(decideReview(store, actor, item.id, item.revision, { kind: "approve" }, [], instant)).rejects.toThrow("illegal_review_transition");
    await detect([{ update_id: 2, edited_channel_post: { ...post().channel_post, edit_date: 1791504001, caption: "Changed" } }]); expect((await candidate()).status).toBe("blocked");
  });
});
describe("worker concurrency, restart and bounded reconciliation", () => {
  it("two stores and workers cannot claim or inspect one candidate twice", async () => {
    await detect(); const second = await openInbox(directory, process.cwd(), channel); ports.search = vi.fn(ports.search);
    await Promise.all([inspectNext(store, ports, now), inspectNext(second, ports, now)]);
    expect(ports.search).toHaveBeenCalledTimes(1); expect((await candidate()).attempts).toBe(1);
  });
  it("expired processing lease is reclaimed after a crash", async () => {
    await detect(); await store.transaction((inbox) => { const item = Object.values(inbox.candidates)[0]; item.status = "inspecting"; item.lease = { token: "dead-worker", until: 1 }; });
    expect(await inspectNext(store, ports, now)).toBe(true); expect((await candidate()).lease).toBeNull();
  });
  it("late worker completion cannot overwrite a newly edited message", async () => {
    await detect(); let release!: () => void; let started!: () => void;
    const gate = new Promise<void>((done) => { release = done; }); const active = new Promise<void>((done) => { started = done; });
    ports.search = async () => { started(); await gate; return []; };
    const work = inspectNext(store, ports, now); await active;
    await detect([{ update_id: 2, edited_channel_post: { ...post().channel_post, edit_date: 1791504001, caption: "New" } }]);
    release(); await work; expect(await candidate()).toMatchObject({ revision: 2, status: "detected" });
  });
  it("bounded reconciliation survives restart and does not infer deletion from message gaps", async () => {
    const page = vi.fn(async (cursor: string | null) => ({ updates: [post(cursor ? 2 : 1, cursor ? 100 : 10, cursor ? "doc2" : "doc1")], next: cursor ? null : "page2", complete: Boolean(cursor), inaccessible: 0 }));
    expect(await reconcile(store, { page }, now, signal(), 1)).toMatchObject({ incomplete: true });
    store = await openInbox(directory, process.cwd(), channel);
    expect(await reconcile(store, { page }, now, signal(), 1)).toMatchObject({ incomplete: false });
    expect((await store.read()).reconciliation.cursor).toBe("page2");
    expect(Object.keys((await store.read()).candidates)).toHaveLength(2); expect((await store.read()).checkpoint).toBeNull();
  });
  it("inaccessible media preserves incomplete reconciliation rather than claiming deletion", async () => {
    const result = await reconcile(store, { page: async () => ({ updates: [], next: null, complete: true, inaccessible: 1 }) }, now, signal());
    expect(result.incomplete).toBe(true); expect(Object.keys((await store.read()).candidates)).toHaveLength(0);
  });
  it("enumerated history documents need no invented Bot API update ID", async () => {
    await reconcile(store, { page: async () => ({ updates: [{ channel_post: post().channel_post }], next: null, complete: true, inaccessible: 0 }) }, now, signal());
    expect((await candidate()).event.updateId).toBeNull(); expect((await store.read()).checkpoint).toBeNull();
    expect(() => detectDocument({ channel_post: post().channel_post }, channel)).toThrow();
  });
  it("shutdown and safe metrics contain no channel/document/credential identifiers", async () => {
    const log = vi.fn(); const controller = new AbortController(); controller.abort();
    const result = await runReplay(store, replayProvider([post()]), ports, { now, signal: controller.signal, log });
    expect(result.stopped).toBe(1); expect(log.mock.calls.flat().join(" ")).not.toContain(String(channel)); expect(result.candidates).toBe(0);
  });
});
