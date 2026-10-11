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
