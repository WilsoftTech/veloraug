import { randomUUID } from "node:crypto";
import { beforeEach,describe,expect,it,vi } from "vitest";
import { emptyUploadMetadata } from "./admin-upload";

const mocks = vi.hoisted(() => ({ assemble: vi.fn(),fingerprint: vi.fn(),hash: vi.fn(),tools: vi.fn(),probe: vi.fn(),classify: vi.fn(),search: vi.fn(),snapshot: vi.fn() }));
vi.mock("@/lib/uploader/disk-transfer",async (original) => ({ ...await original<typeof import("./disk-transfer")>(),assembleDiskUpload: mocks.assemble }));
vi.mock("@/lib/uploader/scan",() => ({ fingerprintFile: mocks.fingerprint,hashFile: mocks.hash }));
vi.mock("@/lib/uploader/media-tools",() => ({ resolveMediaTools: mocks.tools,probeMedia: mocks.probe }));
vi.mock("@/lib/ingestion/media",() => ({ classifyMedia: mocks.classify }));
vi.mock("@/lib/tmdb/ingestion-search",async (original) => ({ ...await original<typeof import("../tmdb/ingestion-search")>(),searchTmdbForIngestion: mocks.search,fetchMovieSnapshot: mocks.snapshot }));
import { inspectAdminUpload } from "./admin-inspection";

function setup(operation: "verify" | "inspect" = "inspect") {
  const id=randomUUID(),token=randomUUID();
  const claim = { manifest: { session: { id,owner_id: randomUUID(),source: "admin_upload",file_name: "Example (2024).mp4",size_bytes: 3,stage: operation === "verify" ? "verifying" : "inspecting",revision: 1,metadata: emptyUploadMetadata,verified_sha256: "a".repeat(64),bytes_received: 3,error_code: null,retryable: false,created_at: new Date().toISOString(),updated_at: new Date().toISOString(),expires_at: new Date(Date.now()+3600000).toISOString() },chunks: [] },token,operation,verified_file_key: randomUUID(),vjs: [] as { id: number; name: string; slug: string; active: boolean }[] };
  const ports={ claim: vi.fn(async () => claim),finish: vi.fn(async (_id: string,_token: string,result: Record<string,unknown>): Promise<string> => result.outcome === "verified" ? "uploaded" : result.outcome === "inspected" ? "metadata_review" : "failed") };
  return { claim,ports };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.assemble.mockResolvedValue({ path: "/private/verified.mp4",sha256: "a".repeat(64),key: randomUUID() });
  mocks.fingerprint.mockResolvedValue(`sf1-${"b".repeat(64)}`);
  mocks.hash.mockResolvedValue("a".repeat(64));
  mocks.tools.mockResolvedValue({ ok: true,tools: { ffprobe: { version: "test" },ffmpeg: { version: "test" } } });
  mocks.probe.mockResolvedValue({ ok: true,inspection: {} });
  mocks.classify.mockReturnValue({ class: "canonical",reasons: [],policyVersion: 1 });
  mocks.search.mockResolvedValue([]);
});
describe("admin upload inspection",() => {
  it("persists byte verification separately from inspection",async () => {
    const { claim,ports }=setup("verify");
    expect(await inspectAdminUpload("C:\\private",ports)).toBe(true);
    expect(ports.finish).toHaveBeenCalledWith(claim.manifest.session.id,claim.token,expect.objectContaining({ outcome: "verified",sha256: "a".repeat(64) }));
    expect(mocks.probe).not.toHaveBeenCalled();
  });
  it("enters metadata review without approving an ambiguous match",async () => {
    const { ports }=setup();
    await inspectAdminUpload("C:\\private",ports);
    expect(ports.finish).toHaveBeenCalledWith(expect.any(String),expect.any(String),expect.objectContaining({ outcome: "inspected",inspection: expect.objectContaining({ choices: [],proposed_tmdb_id: null }) }));
  });
  it("rejects changed bytes before probing or metadata requests",async () => {
    const { ports }=setup(); mocks.hash.mockResolvedValue("c".repeat(64));
    await inspectAdminUpload("C:\\private",ports);
    expect(ports.finish).toHaveBeenCalledWith(expect.any(String),expect.any(String),{ outcome: "failed",code: "upload_chunk_corrupt" });
    expect(mocks.probe).not.toHaveBeenCalled(); expect(mocks.search).not.toHaveBeenCalled();
  });
  it("reuses VJ matching and leaves several matching VJs unresolved",async () => {
    const { claim,ports }=setup();
    claim.manifest.session.file_name="Example (2024) VJ Junior.mp4";
    claim.vjs=[{ id: 1,name: "Junior",slug: "junior",active: true }];
    await inspectAdminUpload("C:\\private",ports);
    expect(ports.finish).toHaveBeenLastCalledWith(expect.any(String),expect.any(String),expect.objectContaining({ inspection: expect.objectContaining({ proposed_vj_id: 1 }) }));
    claim.vjs.push({ id: 2,name: "Junior",slug: "junior-two",active: true });
    await inspectAdminUpload("C:\\private",ports);
    expect(ports.finish).toHaveBeenLastCalledWith(expect.any(String),expect.any(String),expect.objectContaining({ inspection: expect.objectContaining({ proposed_vj_id: null,vj: { status: "ambiguous",candidateIds: [1,2] } }) }));
  });
  it("records a bounded provider failure without leaking credentials",async () => {
    const { ports }=setup(); mocks.search.mockRejectedValue(new Error("https://secret-token.invalid"));
    await inspectAdminUpload("C:\\private",ports);
    expect(ports.finish).toHaveBeenCalledWith(expect.any(String),expect.any(String),{ outcome: "failed",code: "inspection_provider_failed" });
  });
  it("checks persistent completion instead of trusting a successful call",async () => {
    const { ports }=setup("verify"); ports.finish.mockResolvedValueOnce("verifying");
    await inspectAdminUpload("C:\\private",ports);
    expect(ports.finish).toHaveBeenLastCalledWith(expect.any(String),expect.any(String),{ outcome: "failed",code: "upload_verification_not_persisted" });
  });
  it("does no work when the durable queue is empty",async () => {
    const { ports }=setup(); ports.claim.mockResolvedValueOnce(null as never);
    expect(await inspectAdminUpload("C:\\private",ports)).toBe(false);
    expect(ports.finish).not.toHaveBeenCalled();
  });
});
