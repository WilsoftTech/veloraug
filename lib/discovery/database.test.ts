import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { completionPayload, createReviewClient, databasePersistence, storeError, toCandidate, toDelivery, type DiscoveryRpc } from "./database";
import { channelIdentity, detectDocument, newCandidate } from "./events";
import { approvalCommand, publicationCommand, publicationState } from "./owner-commands";
import { botApiUpdateProvider } from "./bot-api-provider";
import type { InspectionPorts } from "./pipeline";
import type { MovieSnapshot } from "@/lib/tmdb/ingestion-search";

const channel = -1001111111111;
const post = (update = 1, message = 10, unique = "AgADuniq10", caption?: string, edited = false) => ({
  update_id: update, [edited ? "edited_channel_post" : "channel_post"]: { message_id: message, date: 1760000000, ...(edited ? { edit_date: 1760000100 } : {}), chat: { id: channel, type: "channel" },
    document: { file_id: `bot-file-${message}`, file_unique_id: unique, file_size: 1048576, file_name: "Example.Movie.2024.VJ.Test.mp4", mime_type: "video/mp4" }, ...(caption ? { caption } : {}) } });
const snapshot = (tmdb: number, title = "Example Movie"): MovieSnapshot => ({ tmdb_id: tmdb, title, original_title: title, overview: "Synthetic.", release_date: "2024-05-01", runtime_minutes: 100, poster_path: null, backdrop_path: null, vote_average: 7, vote_count: 10, genres: [] });
const ok = (data: unknown) => ({ data, error: null });

describe("trusted channel identity (tg1)", () => {
  it("is the same SHA-256 the database computes from [chat, message, file_unique_id, size]", () => {
    const event = detectDocument(post(), channel).event!;
    expect(channelIdentity(event)).toBe(`tg1-${createHash("sha256").update('[-1001111111111,10,"AgADuniq10",1048576]').digest("hex")}`);
  });
  it("needs a known size and a well-formed unique id; captions never change it", () => {
    const event = detectDocument(post(), channel).event!;
    expect(channelIdentity({ ...event, media: { ...event.media, size: null } })).toBeNull();
    expect(channelIdentity({ ...event, media: { ...event.media, uniqueId: "bad id" } })).toBeNull();
    expect(channelIdentity(detectDocument(post(1, 10, "AgADuniq10", "velora-src:sf1-" + "a".repeat(64)), channel).event!)).toBe(channelIdentity(event));
  });
});

describe("deliveries for discovery_receive", () => {
  it("carries the bot file_id to the private row only, and reconciliation keys by event", () => {
    const delivery = toDelivery(post(), channel, false);
    expect(delivery).toMatchObject({ key: "u:1", update_id: 1, withdrawn_message_id: null, event: { message_id: 10, file_id: "bot-file-10", file_unique_id: "AgADuniq10", size: 1048576, kind: "channel_post", observed_at: 1760000000, date: 1760000000 } });
    const history = toDelivery({ channel_post: post().channel_post }, channel, true);
    expect(history.key).toBe(`r:${history.event!.event_id}`); expect(history.update_id).toBeNull(); expect(history.event!.kind).toBe("reconciliation");
  });
  it("names the message an edit withdrew its document from", () => {
    const withdrawn = { update_id: 5, edited_channel_post: { message_id: 10, date: 1760000000, edit_date: 1760000200, chat: { id: channel, type: "channel" }, text: "removed" } };
    expect(toDelivery(withdrawn, channel, false)).toMatchObject({ key: "u:5", event: null, withdrawn_message_id: 10 });
  });
  it("ignores other channels without inventing an event", () => {
    const other = post() as unknown as { channel_post: { chat: { id: number } } }; other.channel_post.chat.id = channel - 1;
    expect(toDelivery(other, channel, false).event).toBeNull();
  });
});

describe("completion payload", () => {
  const candidate = () => ({ ...newCandidate(detectDocument(post(), channel).event!, "2026-10-10T00:00:00.000Z"), title: "Example Movie", year: 2024, vjText: "Test", vjId: 3 });
  it("proposes only a validated choice, with real scores, never a confirmation", () => {
    const payload = completionPayload({ ...candidate(), identity: "proposed", tmdbId: 9800001, choices: [snapshot(9800001), snapshot(9800002, "Other Film")], warnings: ["caption_title_conflict", "Bad Warning!"] }, null, null);
    expect(payload).toMatchObject({ outcome: "review", identity_state: "proposed", proposed_tmdb_id: 9800001, vj_id: 3, warnings: ["caption_title_conflict"], evidence: null });
    expect(payload.candidates.map((item) => [item.tmdb_id, item.score])).toEqual([[9800001, 1], [9800002, 0]]);
  });
  it("drops a proposal that is not among the choices, and evidence for another identity", () => {
    const identity = `tg1-${"b".repeat(64)}`;
    const evidence = { identity: `tg1-${"c".repeat(64)}`, method: "bounded_mtproto_v1", policy_version: 2, media_class: "canonical" as const, reasons: [], container: "mp4", video_codec: "h264", audio_codec: "aac", accessible: true, gateway_compatible: true, playback_ready: true, bytes_read: 1 };
    const payload = completionPayload({ ...candidate(), identity: "proposed", tmdbId: 42, choices: [snapshot(9800001)] }, evidence, identity);
    expect(payload).toMatchObject({ identity_state: "unknown", proposed_tmdb_id: null, evidence: null });
    expect(completionPayload({ ...candidate(), choices: [] }, { ...evidence, identity }, identity).evidence).toMatchObject({ identity });
  });
  it("reports a blocked inspection with its fixed code only", () => {
    expect(completionPayload({ ...candidate(), status: "blocked", error: "series_out_of_scope" }, null, null)).toMatchObject({ outcome: "blocked", error_code: "series_out_of_scope", candidates: [] });
  });
});

describe("worker persistence over RPC", () => {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc = (replies: Record<string, unknown>): DiscoveryRpc => async (fn, args) => {
    calls.push({ fn, args });
    const reply = replies[fn];
    return reply instanceof Error ? { data: null, error: { message: reply.message, code: "P0001" } } : ok(typeof reply === "function" ? reply(args) : reply);
  };
  it("claims media independently of reviews, and uses only the media result commands", async () => {
    calls.length=0;
    const raw={media_id:1,identity:`tg1-${"a".repeat(64)}`,lease:"00000000-0000-4000-8000-000000000001",
      chat_id:channel,message_id:42,file_unique_id:"AgADupload42",size:1000,name:"Unknown.mkv",mime:"video/x-matroska"};
    const store=databasePersistence(rpc({media_verification_claim:raw,media_verification_finish:"retry"}),{channelId:channel});
    const result=await store.verifyMediaNext(async(event)=>{
      expect(event.media.name).toBe("Unknown.mkv");
      throw new Error("https://secret.invalid/token");
    },()=>new Date());
    expect(result).toEqual({outcome:"retry",evidence:null});
    expect(calls.map(item=>item.fn)).toEqual(["media_verification_claim","media_verification_finish"]);
    expect(calls[1].args).toMatchObject({p_media_id:1,p_token:raw.lease,p_identity:raw.identity,p_evidence:null,p_error:"inspection_provider_failed"});
    expect(JSON.stringify(calls)).not.toContain("secret.invalid");
  });
  it("does not read media when no upload is due", async () => {
    calls.length=0;
    const media=vi.fn();
    const store=databasePersistence(rpc({media_verification_claim:null}),{channelId:channel});
    expect(await store.verifyMediaNext(media,()=>new Date())).toEqual({outcome:"idle",evidence:null});
    expect(media).not.toHaveBeenCalled();
    expect(calls.map(item=>item.fn)).toEqual(["media_verification_claim"]);
  });
  const claim = { key: "a".repeat(64), revision: 1, lease: "00000000-0000-4000-8000-000000000001", attempts: 1, event_id: "b".repeat(64), payload_digest: "c".repeat(64),
    observed_at: 1760000000, update_id: 1, kind: "channel_post", chat_id: channel, message_id: 10, file_unique_id: "AgADuniq10", size: 1048576,
    name: "Example.Movie.2024.VJ.Test.mp4", mime: "video/mp4", caption: null, identity: `tg1-${"d".repeat(64)}` };
  const ports = (media: InspectionPorts["media"]): InspectionPorts => ({
    catalogue: async () => [], vjs: async () => [{ id: 3, slug: "vj-test", name: "VJ Test", isActive: true }],
    search: async () => [{ tmdbId: 9800001, mediaType: "movie", title: "Example Movie", originalTitle: "Example Movie", year: 2024 }],
    snapshot: async (id) => snapshot(id), media,
  });

  it("records batches only under its consumer lease token", async () => {
    calls.length = 0;
    const store = databasePersistence(rpc({ discovery_acquire_consumer: [{ update_offset: 7, reconciliation_cursor: null, reconciliation_checked_at: null, reconciliation_incomplete: true }], discovery_receive: { detected: 1, duplicates: 0, ignored: 0, update_offset: 8 } }), { channelId: channel, consumer: "00000000-0000-4000-8000-0000000000c1" });
    expect(await store.checkpoint()).toBe(7);
    await store.receive([post(8)], new Date());
    expect(calls.map((call) => call.fn)).toEqual(["discovery_acquire_consumer", "discovery_receive"]);
    expect(calls[1].args).toMatchObject({ p_token: "00000000-0000-4000-8000-0000000000c1", p_chat_id: channel, p_reconciliation: null });
    await expect(store.receive(Array.from({ length: 101 }, (_, i) => post(i)), new Date())).rejects.toThrow("batch_limit");
  });

  it("inspects under the fenced lease and submits evidence for the claimed identity only", async () => {
    calls.length = 0;
    const evidence = { identity: claim.identity, method: "bounded_mtproto_v1", policy_version: 2, media_class: "canonical" as const, reasons: [], container: "mp4", video_codec: "h264", audio_codec: "aac", accessible: true, gateway_compatible: true, playback_ready: true, bytes_read: 3072 };
    const store = databasePersistence(rpc({ discovery_claim: claim, discovery_complete: "needs_review" }), { channelId: channel });
    expect(await store.inspectNext(ports(async () => ({ duplicateOf: "x".repeat(64), source: null, evidence: null, verification: evidence })), () => new Date())).toBe(true);
    const complete = calls.find((call) => call.fn === "discovery_complete")!;
    expect(complete.args).toMatchObject({ p_key: claim.key, p_lease: claim.lease, p_revision: 1 });
    expect(complete.args.p_result).toMatchObject({ outcome: "review", identity_state: "proposed", proposed_tmdb_id: 9800001, vj_id: 3, evidence: { identity: claim.identity } });
  });

  it("a provider failure is recorded with a fixed code and never its message", async () => {
    calls.length = 0;
    const store = databasePersistence(rpc({ discovery_claim: claim, discovery_fail: "failed" }), { channelId: channel });
    await store.inspectNext(ports(async () => { throw new Error("token=SECRET https://example.invalid"); }), () => new Date());
    expect(calls.map((call) => call.fn)).toEqual(["discovery_claim", "discovery_fail"]);
    expect(JSON.stringify(calls)).not.toContain("SECRET");
    expect(calls[1].args.p_code).toBe("inspection_provider_failed");
  });

  describe("a confirmed candidate (media-only inspection)", () => {
    const selection = { title: "Example Movie", year: 2024, vj_text: "Test", vj_id: 3, tmdb_id: 9800001, snapshot: snapshot(9800001) };
    const confirmed = { ...claim, revision: 4, confirmed_selection: selection };
    const evidence = (reasons: string[]) => ({ identity: claim.identity, method: "bounded_mtproto_v1", policy_version: 2, media_class: reasons.length ? "unverified" as const : "canonical" as const, reasons,
      container: reasons.length ? null : "mp4", video_codec: reasons.length ? null : "h264", audio_codec: reasons.length ? null : "aac", accessible: !reasons.length, gateway_compatible: true, playback_ready: !reasons.length, bytes_read: 3072 });
    // Any metadata lookup would be a second look at something the reviewer already decided.
    const mediaOnly = (media: InspectionPorts["media"]): InspectionPorts => {
      const refuse = async (): Promise<never> => { throw new Error("metadata_lookup_not_expected"); };
      return { catalogue: refuse, vjs: refuse, search: refuse, snapshot: refuse, media };
    };

    it("reads the media only and sends the confirmed choice back unchanged", async () => {
      calls.length = 0;
      const store = databasePersistence(rpc({ discovery_claim: confirmed, discovery_complete: "needs_review" }), { channelId: channel });
      expect(await store.inspectNext(mediaOnly(async () => ({ duplicateOf: null, source: null, evidence: null, verification: evidence([]) })), () => new Date())).toBe(true);
      expect(calls.map((call) => call.fn)).toEqual(["discovery_claim", "discovery_complete"]);
      expect(calls[1].args).toMatchObject({ p_key: claim.key, p_lease: claim.lease, p_revision: 4 });
      expect(calls[1].args.p_result).toMatchObject({ outcome: "review", title: "Example Movie", year: 2024, vj_text: "Test", vj_id: 3, identity_state: "proposed", proposed_tmdb_id: 9800001,
        candidates: [{ tmdb_id: 9800001, snapshot: { tmdb_id: 9800001 } }], evidence: { identity: claim.identity, media_class: "canonical" } });
    });

    it("schedules a transient reader failure for retry and never records it as evidence", async () => {
      calls.length = 0;
      const store = databasePersistence(rpc({ discovery_claim: confirmed, discovery_fail: "failed" }), { channelId: channel });
      await store.inspectNext(mediaOnly(async () => ({ duplicateOf: null, source: null, evidence: null, verification: evidence(["media_read_flood_wait"]) })), () => new Date());
      expect(calls.map((call) => call.fn)).toEqual(["discovery_claim", "discovery_fail"]);
      expect(calls[1].args).toEqual({ p_key: claim.key, p_lease: claim.lease, p_revision: 4, p_code: "media_read_flood_wait" });
    });

    it("records a property of the document as evidence: it stays blocked at the media gate with its reason", async () => {
      calls.length = 0;
      const store = databasePersistence(rpc({ discovery_claim: confirmed, discovery_complete: "needs_review" }), { channelId: channel });
      await store.inspectNext(mediaOnly(async () => ({ duplicateOf: null, source: null, evidence: null, verification: evidence(["container_not_mp4"]) })), () => new Date());
      expect(calls.map((call) => call.fn)).toEqual(["discovery_claim", "discovery_complete"]);
      expect(calls[1].args.p_result).toMatchObject({ evidence: { media_class: "unverified", reasons: ["container_not_mp4"], playback_ready: false } });
    });

    it("completes without evidence when the worker has no media reader, and fails with a fixed code when the reader throws", async () => {
      calls.length = 0;
      const none = databasePersistence(rpc({ discovery_claim: confirmed, discovery_complete: "needs_review" }), { channelId: channel });
      await none.inspectNext(mediaOnly(async () => ({ duplicateOf: null, source: null, evidence: null })), () => new Date());
      expect(calls[1].args.p_result).toMatchObject({ evidence: null, proposed_tmdb_id: 9800001 });
      calls.length = 0;
      const broken = databasePersistence(rpc({ discovery_claim: confirmed, discovery_fail: "failed" }), { channelId: channel });
      await broken.inspectNext(mediaOnly(async () => { throw new Error("session=SECRET"); }), () => new Date());
      expect(calls[1]).toMatchObject({ fn: "discovery_fail", args: { p_code: "inspection_provider_failed" } }); expect(JSON.stringify(calls)).not.toContain("SECRET");
    });

    it("an unconfirmed candidate keeps its first-inspection behaviour: unreadable media is recorded, metadata is not thrown away", async () => {
      calls.length = 0;
      const store = databasePersistence(rpc({ discovery_claim: { ...claim, confirmed_selection: null }, discovery_complete: "needs_review" }), { channelId: channel });
      await store.inspectNext(ports(async () => ({ duplicateOf: null, source: null, evidence: null, verification: evidence(["media_read_flood_wait"]) })), () => new Date());
      expect(calls.map((call) => call.fn)).toEqual(["discovery_claim", "discovery_complete"]);
      expect(calls[1].args.p_result).toMatchObject({ identity_state: "proposed", proposed_tmdb_id: 9800001, evidence: { reasons: ["media_read_flood_wait"] } });
    });
  });

  it("returns false when nothing is due and maps database refusals to fixed codes", async () => {
    expect(await databasePersistence(rpc({ discovery_claim: null }), { channelId: channel }).inspectNext(ports(async () => ({ duplicateOf: null, source: null, evidence: null })), () => new Date())).toBe(false);
    await expect(databasePersistence(rpc({ discovery_acquire_consumer: new Error("discovery_consumer_busy") }), { channelId: channel }).checkpoint()).rejects.toMatchObject({ code: "discovery_consumer_busy" });
    expect(storeError({ message: "permission denied for function discovery_receive", code: "42501" }).code).toBe("review_not_authorized");
    expect(storeError({ message: "review_gates_not_met", details: "rights_clearance_required,media_verification_required" })).toMatchObject({ code: "review_gates_not_met", detail: "rights_clearance_required,media_verification_required" });
    expect(storeError({ message: "duplicate key value violates unique constraint \"x\"", details: "Key (id)=(1)" })).toMatchObject({ code: "store_error", detail: null });
    await expect(databasePersistence(async () => { throw new Error("network"); }, { channelId: channel }).checkpoint()).rejects.toMatchObject({ code: "store_unavailable" });
  });
});

describe("reviewer client mapping", () => {
  const view = (status: string, blockers: string[], extra: Record<string, unknown> = {}) => ({
    key: "a".repeat(64), revision: 3, status, error_code: null, attempts: 1, first_seen: "2026-10-10T09:00:00.123456+00:00", last_seen: "2026-10-10T09:05:00+00:00",
    event: { event_id: "b".repeat(64), payload_digest: "c".repeat(64), chat_id: channel, message_id: 10, update_id: 100, kind: "channel_post", observed_at: 1760000000,
      file_unique_id: "AgADuniq10", size: 1048576, name: "Example.Movie.2024.VJ.Test.mp4", mime: "video/mp4", caption: null },
    identity: `tg1-${"d".repeat(64)}`, identity_state: "confirmed", title: "Example Movie", year: 2024, vj_text: "Test", warnings: [], tmdb_id: 9800001,
    vj: { id: 3, slug: "vj-test", name: "VJ Test", active: true }, relation: "new_movie", movie_id: null, duplicate_of: null, snapshot: snapshot(9800001),
    evidence: { identity: `tg1-${"d".repeat(64)}`, verified: true, method: "bounded_mtproto_v1", scope: "bounded", policy_version: 2, media_class: "canonical", reasons: [], container: "mp4",
      video_codec: "h264", audio_codec: "aac", accessible: true, gateway_compatible: true, playback_ready: true, bytes_read: 3072, checked_at: "2026-10-10T09:01:00+00:00" },
    rights: null, approval: null, publication: null, blockers, ...extra });

  it("maps database states and gates onto the review model", () => {
    expect(toCandidate(view("needs_review", ["rights_clearance_required"])).status).toBe("awaiting_rights");
    expect(toCandidate(view("needs_review", ["media_verification_required", "rights_clearance_required"])).status).toBe("awaiting_media");
    expect(toCandidate(view("needs_review", [])).status).toBe("awaiting_review");
    expect(toCandidate(view("matched", [], { approval: { revision: 3, by: "00000000-0000-4000-8000-0000000000a1", at: "2026-10-10T09:06:00+00:00" } })).status).toBe("approved");
    const published = toCandidate(view("published", ["candidate_closed"], { publication: { movie_slug: "example-movie-2024", version_id: 4, published_at: null } }));
    expect(published).toMatchObject({ status: "published", publication: { movieSlug: "example-movie-2024", versionId: 4 }, gates: ["candidate_closed"] });
    const mapped = toCandidate(view("needs_review", []));
    expect(mapped.evidence).toMatchObject({ container: true, gateway: true, browser: true, mediaClass: "canonical", video: "h264", bytesRead: 3072 });
    expect(mapped.evidence!.reference).toContain("not full-file integrity");
    expect(mapped.firstSeen).toBe("2026-10-10T09:00:00.123Z");
  });

  it("carries the worker's last inspection and the next retry when the database reports them", () => {
    const failed = toCandidate(view("failed", ["inspection_pending"], { error_code: "media_read_flood_wait", attempts: 2,
      inspection: { retry_at: "2026-10-11T12:01:00+00:00", last: { at: "2026-10-11T12:00:00.5+00:00", action: "inspection_failed", detail: "media_read_flood_wait", revision: 3 } } }));
    expect(failed).toMatchObject({ status: "failed", attempts: 2, retryAt: Date.parse("2026-10-11T12:01:00Z"), lastInspection: { at: "2026-10-11T12:00:00.500Z", action: "inspection_failed", detail: "media_read_flood_wait", revision: 3 } });
    expect(toCandidate(view("needs_review", [], { inspection: { retry_at: null, last: null } }))).toMatchObject({ retryAt: 0, lastInspection: null });
    // A database without the migration: no last inspection at all, which is how the UI knows not to offer the media-only check.
    const older = toCandidate(view("needs_review", []));
    expect(older.retryAt).toBe(0); expect(older.lastInspection).toBeUndefined();
  });

  it("refuses a view that claims anything but a bounded check", () => {
    const bad = view("needs_review", []);
    (bad.evidence as Record<string, unknown>).scope = "full";
    expect(() => toCandidate(bad)).toThrow();
  });

  it("calls only the reviewer commands, with the reviewer's own arguments", async () => {
    const seen: string[] = [];
    const client = createReviewClient(async (fn, args) => { seen.push(`${fn}:${JSON.stringify(args)}`); return ok(view("needs_review", [])); });
    await client.correct("a".repeat(64), 3, { tmdbId: 9800001, year: 2024, vjId: 3 });
    await client.clearRights("a".repeat(64), 4, "contract E38A-001");
    expect(seen[0]).toContain("discovery_review_correct"); expect(seen[1]).toContain("discovery_review_clear_rights");
  });
  it("approves and publishes as the session: no reviewer id is ever sent", async () => {
    const seen: { fn: string; args: Record<string, unknown> }[] = [];
    const client = createReviewClient(async (fn, args) => { seen.push({ fn, args }); return ok(fn === "discovery_review_publish" ? { result: "published", movie_slug: "example-movie-2024", version_id: 4, vj_slug: "vj-test" } : view("matched", [])); });
    expect((await client.approve("a".repeat(64), 3)).status).toBe("approved");
    expect(await client.publish("a".repeat(64), 3)).toMatchObject({ result: "published", movie_slug: "example-movie-2024" });
    expect(seen).toEqual([{ fn: "discovery_review_approve", args: { p_key: "a".repeat(64), p_revision: 3 } }, { fn: "discovery_review_publish", args: { p_key: "a".repeat(64), p_revision: 3 } }]);
    await expect(createReviewClient(async () => ({ data: null, error: { message: "review_gates_not_met", code: "P0001", details: "media_verification_required" } })).approve("a".repeat(64), 3))
      .rejects.toMatchObject({ code: "review_gates_not_met", detail: "media_verification_required" });
  });
  it("reports a database without the dashboard commands as unavailable, not as an error", async () => {
    const missing = createReviewClient(async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.discovery_review_capabilities" } }));
    expect(await missing.capabilities()).toBeNull(); expect(await missing.movies()).toBeNull();
    await expect(missing.approve("a".repeat(64), 1)).rejects.toMatchObject({ code: "command_unavailable" });
    // Any other refusal is still a refusal.
    await expect(createReviewClient(async () => ({ data: null, error: { code: "42501", message: "permission denied" } })).movies()).rejects.toMatchObject({ code: "review_not_authorized" });
    expect(await createReviewClient(async () => ok({ review: true, rights: false, publish: false })).capabilities()).toEqual({ review: true, rights: false, publish: false });
  });
});

describe("owner commands (psql only)", () => {
  const key = "a".repeat(64), reviewer = "00000000-0000-4000-8000-0000000000a1";
  it("prepare the exact catalogue_review calls", () => {
    expect(approvalCommand(key, 3, reviewer)).toContain(`select catalogue_review.approve_channel_candidate('${key}', 3, '${reviewer}');`);
    expect(publicationCommand(key, 3, reviewer)).toContain(`select catalogue_review.publish_channel_candidate('${key}', 3, '${reviewer}');`);
  });
  it("refuse anything that could reach the SQL text", () => {
    expect(() => approvalCommand("a'); drop table x; --".padEnd(64, "a"), 3, reviewer)).toThrow("owner_command_input_invalid");
    expect(() => publicationCommand(key, 0, reviewer)).toThrow(); expect(() => publicationCommand(key, 1.5, reviewer)).toThrow();
    expect(() => publicationCommand(key, 3, "'; select 1; --")).toThrow();
  });
  it("reconcile an uncertain publication from database state only", () => {
    expect(publicationState({ status: "published", publication: { movieSlug: "x", versionId: 1 }, approval: { actor: reviewer, at: "2026-10-10T00:00:00.000Z", revision: 3 } }, 3)).toBe("published");
    expect(publicationState({ status: "approved", publication: null, approval: { actor: reviewer, at: "2026-10-10T00:00:00.000Z", revision: 3 } }, 3)).toBe("approved_not_published");
    expect(publicationState({ status: "awaiting_review", publication: null, approval: null }, 3)).toBe("not_approved");
    expect(publicationState({ status: "approved", publication: null, approval: { actor: reviewer, at: "2026-10-10T00:00:00.000Z", revision: 2 } }, 3)).toBe("not_approved");
  });
});

describe("Bot API update provider (not started; fakes only)", () => {
  it("polls after the committed checkpoint only", async () => {
    const poll = vi.fn(async () => ({ status: "ok" as const, updates: [{ update_id: 7 }, { update_id: 8, channel_post: {} }] }));
    const updates = await botApiUpdateProvider(poll).batch(7, 100, new AbortController().signal);
    expect(updates).toEqual([{ update_id: 8, channel_post: {} }]);
    expect(poll).toHaveBeenCalledWith({ offset: 8, limit: 100, timeoutSeconds: 25 }, expect.any(AbortSignal));
  });
  it("refuses to poll without an explicit cursor offset (never the whole pending queue)", async () => {
    const poll = vi.fn(async () => ({ status: "ok" as const, updates: [] }));
    await expect(botApiUpdateProvider(poll).batch(null, 100, new AbortController().signal)).rejects.toMatchObject({ code: "discovery_cursor_offset_required", fatal: true });
    expect(poll).not.toHaveBeenCalled();
  });
  it("a competing consumer or a refused bot is fatal; transient failures and rate limits are retryable", async () => {
    const signal = new AbortController().signal;
    await expect(botApiUpdateProvider(async () => ({ status: "conflict" })).batch(1, 100, signal)).rejects.toMatchObject({ code: "telegram_update_consumer_conflict", fatal: true });
    await expect(botApiUpdateProvider(async () => ({ status: "blocked", code: "bot_identity_mismatch" })).batch(1, 100, signal)).rejects.toMatchObject({ code: "bot_identity_mismatch", fatal: true });
    await expect(botApiUpdateProvider(async () => ({ status: "transient", code: "bot_api_unreachable" })).batch(1, 100, signal)).rejects.toMatchObject({ code: "bot_api_unreachable", fatal: false });
    await expect(botApiUpdateProvider(async () => ({ status: "rate_limited", retryAfterSeconds: 7 })).batch(1, 100, signal)).rejects.toMatchObject({ code: "telegram_rate_limited", fatal: false, retryAfterSeconds: 7 });
    expect(() => botApiUpdateProvider(async () => ({ status: "ok", updates: [] }), { timeoutSeconds: 120 })).toThrow("poll_timeout_invalid");
  });
  it("returns nothing when shut down during the poll", async () => {
    const controller = new AbortController();
    const provider = botApiUpdateProvider(async () => { controller.abort(); return { status: "transient", code: "get_updates_timeout" }; });
    expect(await provider.batch(1, 100, controller.signal)).toEqual([]);
  });
});
