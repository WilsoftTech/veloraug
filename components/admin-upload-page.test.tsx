import { mkdirSync, writeFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/uploader/admin-runtime", () => ({ uploadClient: async () => ({ get: mocks.get }) }));
vi.mock("@/app/admin/uploads/actions", () => ({ cancelUploadAction: async () => {}, refreshUploadPagesAction: async () => {}, retryUploadAction: async () => {}, saveUploadAction: async () => {}, reviewUploadAction: async () => {} }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not_found"); }, useRouter: () => ({ refresh() {} }) }));
import UploadPage from "@/app/admin/uploads/[id]/page";

const id = "00000000-0000-4000-8000-0000000000b1";
const film = { tmdb_id: 9820001, title: "Uploaded Film", original_title: null, overview: "A synthetic upload.", release_date: "2025-03-01", runtime_minutes: 101, poster_path: null, backdrop_path: null, vote_average: 7, vote_count: 10, genres: [] };
const pipeline = { media_verified: true, telegram_status: "uploaded", rights_cleared: true, rights_rejected: false, rights_expires_at: "2027-01-01T00:00:00.000Z" as string | null, rights_reference: "licence UPL-001" as string | null,
  approved: true, cleanup_state: "cleaned" as string | null, cleanup_error: null, publication_slug: "uploaded-film-2025" as string | null, stored: true, audit: [{ action: "rights_cleared", at: "2026-10-11T09:00:00Z", revision: 7 }, { action: "published", at: "2026-10-11T09:30:00Z", revision: 9 }] };
// The session view the page reads (lib/uploader/admin-upload.ts). Built by hand: only the guarded upload entry points import that module.
const session = (stage: string, extra: Record<string, unknown> = {}) => ({ id, source: "admin_upload", owner_id: "00000000-0000-4000-8000-0000000000a1", storage: "r2",
  file_name: "Uploaded.Film.2025.VJ.Test.A.Rather.Long.File.Name.For.Wrapping.mp4", size_bytes: 1_917_405_700, stage, revision: 9, metadata: { kind: "movie", title: "Uploaded Film", year: 2025, vjId: 3, snapshot: film, season: null, episode: null, provenance: "Licensed master." },
  verified_sha256: "a".repeat(64), bytes_received: 1_917_405_700, error_code: null, retryable: false, created_at: "2026-10-11T00:00:00Z", updated_at: "2026-10-11T00:00:00Z", expires_at: "2026-10-18T00:00:00Z",
  pipeline, inspection: { choices: [film], proposed_tmdb_id: film.tmdb_id, proposed_vj_id: 3, classification: { class: "canonical", reasons: [], policyVersion: 2 } }, ...extra });
const render = async (value: ReturnType<typeof session>, result?: string) => {
  mocks.get.mockResolvedValue(value);
  return renderToStaticMarkup(await UploadPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(result ? { result } : {}) }));
};
const waiting = { ...pipeline, rights_cleared: false, rights_expires_at: null, rights_reference: null, approved: false, cleanup_state: "retained", publication_slug: null, stored: false, telegram_status: "pending" };

describe("admin upload detail page", () => {
  beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("VELORA_ADMIN_UPLOADS_ENABLED", "true"); });

  it("is absent unless the feature is enabled, and for a malformed id", async () => {
    vi.stubEnv("VELORA_ADMIN_UPLOADS_ENABLED", "false");
    await expect(UploadPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })).rejects.toThrow("not_found");
    vi.stubEnv("VELORA_ADMIN_UPLOADS_ENABLED", "true");
    await expect(UploadPage({ params: Promise.resolve({ id: "../etc" }), searchParams: Promise.resolve({}) })).rejects.toThrow("not_found");
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("a published session links to the movie and offers the public page refresh, and nothing that could change it", async () => {
    const html = await render(session("published"), "refreshed");
    for (const text of ["Published", "Stored", "Cleared", "Verified", 'href="/movies/uploaded-film-2025"', "Refresh public pages", "Public catalogue pages were refreshed.", "cleaned up", "Inspect operation history", 'role="status"']) expect(html).toContain(text);
    for (const text of ["Cancel upload", "Approve transfer and publication", "Reject distribution rights", 'type="file"']) expect(html).not.toContain(text);
    expect(html).toMatch(/<fieldset disabled=""/); // metadata is read-only after publication
    // Published in name only (not approved, or no catalogue row read back): no link and no refresh.
    for (const flow of [{ ...pipeline, approved: false }, { ...pipeline, publication_slug: null }]) {
      const other = await render(session("published", { pipeline: flow }));
      expect(other).not.toContain("Refresh public pages"); expect(other).not.toContain("View published movie");
    }
  });

  // Checkpoint 9: the media panel on an upload.
  it("shows the Policy 3 assessment as separate facts, pending until the database verifies them", async () => {
    const assessment = { accepted: true, container: "mkv", reasons: [], warnings: ["firefox_mkv_streaming_unreliable", "audio_track_switching_not_available", "embedded_subtitles_not_displayed"], integrity: "metadata_consistent", streaming: "potentially_playable",
      download: "not_implemented_authorization_required", compatibility: { basis: "tested_fixture_combinations", perFile: "prediction", evidence: "docs", chromium: "tested_combination", firefox: "streaming_unreliable", safari: "real_device_not_tested", ios: "real_device_not_tested", android: "real_device_not_tested" },
      tracks: [{ index: 0, type: "video", codec: "H264", attachedPicture: false, title: "PRIVATE TRACK TITLE" }, { index: 1, type: "audio", codec: "aac", attachedPicture: false }, { index: 2, type: "audio", codec: "aac", attachedPicture: false }, { index: 3, type: "subtitle", codec: "subrip", attachedPicture: false }] };
    const html = await render(session("metadata_review", { file_name: "Uploaded.Film.2025.VJ.Test.mkv", pipeline: { ...waiting, media_verified: false }, inspection: { choices: [film], proposed_tmdb_id: film.tmdb_id, proposed_vj_id: 3, classification: { class: "original", reasons: [], policyVersion: 3 }, assessment } }));
    for (const text of ["Media inspection", "MKV", "Uploaded.Film.2025.VJ.Test.mkv", "h264", "aac", "Metadata consistent, not verified", "Potentially playable, not verified", "Limited in some browsers", "Version 3", "Switched off",
      "Firefox does not stream MKV reliably.", "plays only the default one", "Embedded subtitles are not shown by the player.", "Awaiting verification"]) expect(html, text).toContain(text);
    expect(html).toMatch(/Audio tracks<\/dt><dd[^>]*>2</); expect(html).toMatch(/Subtitle tracks<\/dt><dd[^>]*>1</);
    expect(html).not.toContain("PRIVATE TRACK TITLE"); expect(html).not.toContain(">Failed<");
  });

  it("without the Policy 3 readback the upload page still renders: earlier facts shown, the rest not reported", async () => {
    const html = await render(session("published"));
    for (const text of ["Media inspection", "Not reported", "migration 20261011192618", "Verified by the earlier MP4 policy", "Version 2", "canonical", "Switched off"]) expect(html, text).toContain(text);
    // A Policy 3 inspection whose assessment did not come back (lib/uploader/admin-upload.test.ts covers the parsing): nothing is verified or failed.
    const bare = await render(session("metadata_review", { pipeline: { ...waiting, media_verified: false }, inspection: { choices: [film], proposed_tmdb_id: film.tmdb_id, classification: { class: "original", reasons: [], policyVersion: 3 } } }));
    expect(bare).toContain("Not reported"); expect(bare).toContain("Awaiting verification"); expect(bare).not.toContain(">Verified<"); expect(bare).not.toContain(">Failed<");
    // A refused Policy 3 file is a failure, in the panel and in the status row. A session with no inspection has no panel.
    const refused = await render(session("metadata_review", { pipeline: { ...waiting, media_verified: false }, inspection: { choices: [], proposed_tmdb_id: null, classification: { class: "manual_review", reasons: ["size_mismatch"], policyVersion: 3 },
      assessment: { container: "mp4", integrity: "incomplete", streaming: "unverified", compatibility: {}, warnings: [], tracks: [] } } }));
    expect(refused.match(/>Failed</g)).toHaveLength(3); expect(refused).toContain("does not match what its container reports");
    expect(await render(session("uploading", { pipeline: waiting, inspection: null, bytes_received: 10 }))).not.toContain("Media inspection");
    vi.stubEnv("MEDIA_GATEWAY_DOWNLOADS_ENABLED", "true");
    expect(await render(session("published"))).toContain("Switched on");
    expect(await render(session("metadata_review", { pipeline: waiting }))).toContain("Not available until published");
  });

  it("keeps rights, approval and transfer as separate, labelled steps before publication", async () => {
    const html = await render(session("awaiting_approval", { pipeline: { ...waiting, rights_cleared: true, rights_expires_at: "2027-01-01T00:00:00.000Z", rights_reference: "licence UPL-001" } }));
    for (const text of ['for="rights-reference"', 'for="rights-expiry"', 'value="clear_rights"', 'value="revoke_rights"', 'value="approve"', 'value="reject_rights"', "Uploading never grants rights", "Pending transfer", "Blocked", "Cancel upload", "retained"]) expect(html).toContain(text);
    for (const text of ["Refresh public pages", "View published movie", 'type="file"']) expect(html).not.toContain(text);
    const review = await render(session("metadata_review", { pipeline: waiting }));
    for (const text of ['value="submit"', 'value="reinspect"', 'for="upload-tmdb"', "Uploaded Film (2025)", "Suggestions are not approvals"]) expect(review).toContain(text);
    for (const text of ['value="approve"', 'value="clear_rights"']) expect(review).not.toContain(text);
    // An uncertain Telegram transfer can be neither cancelled nor edited from the page.
    const uncertain = await render(session("telegram_uncertain", { pipeline: { ...waiting, rights_cleared: true, approved: true } }));
    expect(uncertain).toContain("Reconciling uncertain transfer"); expect(uncertain).not.toContain("Cancel upload"); expect(uncertain).toMatch(/<fieldset disabled=""/);
  });

  it("a draft offers the resumable transfer with a labelled picker that never submits the file", async () => {
    const html = await render(session("uploading", { bytes_received: 0, verified_sha256: null, inspection: null, pipeline: { ...waiting, media_verified: false } }));
    const picker = html.match(/<input[^>]*type="file"[^>]*>/)?.[0];
    expect(picker).toBeDefined(); expect(picker).not.toMatch(/\sname=/);
    for (const text of ["Uploading / paused", "Awaiting verification", "Cancel upload"]) expect(html).toContain(text);
  });

  it("can export synthetic server markup for explicit offline responsive verification", async () => {
    if (process.env.VELORA_E38_UI_PREVIEW !== "true") return;
    const directory = ".velora-ingest/e3.8"; mkdirSync(directory, { recursive: true });
    const parts = {
      "upload-published": await render(session("published"), "refreshed"),
      "upload-approval": await render(session("awaiting_approval", { pipeline: { ...waiting, rights_cleared: true, rights_expires_at: "2027-01-01T00:00:00.000Z", rights_reference: "licence UPL-001" } })),
      "upload-review": await render(session("metadata_review", { pipeline: waiting })),
      "upload-transfer": await render(session("uploading", { bytes_received: 0, verified_sha256: null, inspection: null, pipeline: { ...waiting, media_verified: false } })),
    };
    for (const [name, body] of Object.entries(parts)) writeFileSync(`${directory}/${name}.preview.html`, `<!doctype html><html lang="en" data-theme="dark"><meta name="viewport" content="width=device-width, initial-scale=1"><body><main class="page-container py-6 sm:py-8">${body}</main></body></html>`);
    expect(parts["upload-published"]).toContain("Refresh public pages");
  });
});
