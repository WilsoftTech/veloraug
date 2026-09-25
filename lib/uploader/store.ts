import type { CatalogueKind } from "@/types/catalogue";
import type { ServerUploadStatus, SourceFingerprint, SourceIdentity, TelegramMediaRecord } from "@/types/ingestion";

/**
 * The uploader's view of the Supabase ingestion write boundary: commands, not
 * table access. Each method corresponds to one proposed worker RPC (see
 * "Worker write boundary" in docs/PHASE_C_INGESTION_DESIGN.md). None of them
 * approves or publishes anything.
 *
 * C2A ships no implementation that reaches the database. The private
 * ingestion schema cannot hold an uploader-originated record yet
 * (ingestion_events requires a Telegram update id), so migration 9 awaits a
 * schema decision. Until then `unavailableStore` refuses every call, which
 * also makes a real upload impossible: an upload may not start unless the
 * server has recorded that it is starting.
 */
export interface IngestionStore {
  readonly available: boolean;
  /** What the server knows about this source's upload. */
  getUploadStatus(fingerprint: SourceFingerprint, kind: CatalogueKind): Promise<ServerUploadStatus>;
  /**
   * Registers the source (idempotent by fingerprint) and records that attempt
   * `attempt` is starting. Refused when the source is uploaded, rejected or
   * already uploading.
   */
  markUploadStarted(input: { source: SourceIdentity; kind: CatalogueKind; attempt: number }): Promise<void>;
  /**
   * Records the Telegram message from a sendDocument reply or a confirmed
   * reconciliation. Replaying the same message is `already_recorded`; a
   * different message for the same source is `conflict` (review), never an
   * overwrite.
   */
  recordUploadSucceeded(fingerprint: SourceFingerprint, record: TelegramMediaRecord): Promise<"recorded" | "already_recorded" | "conflict">;
  /** Records a definite failure or an abandoned attempt; the source may be retried. */
  recordUploadFailed(fingerprint: SourceFingerprint, failure: { code: string; retryable: boolean }): Promise<void>;
}

export class StoreUnavailableError extends Error {
  constructor() {
    super("The ingestion write boundary (migration 9) is not deployed; nothing can be recorded in Supabase.");
    this.name = "StoreUnavailableError";
  }
}

const refuse = async (): Promise<never> => {
  throw new StoreUnavailableError();
};

export const unavailableStore: IngestionStore = {
  available: false,
  getUploadStatus: async () => ({ status: "unknown" }),
  markUploadStarted: refuse,
  recordUploadSucceeded: refuse,
  recordUploadFailed: refuse,
};
