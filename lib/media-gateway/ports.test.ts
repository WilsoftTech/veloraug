import { describe, expect, it } from "vitest";
import { locatorIdentity, type MediaLocator } from "@/lib/media-gateway/ports";

const mkv: MediaLocator = {
  movieVersionId: 1,
  chatId: "-1001234567890",
  messageId: 23,
  fileUniqueId: "AgADmkv",
  fileSize: 1_004_462_878,
  mimeType: "video/x-matroska",
};

describe("locatorIdentity", () => {
  it("is equal for equal locators, so a cached resolution is reused", () => {
    expect(locatorIdentity({ ...mkv })).toBe(locatorIdentity(mkv));
  });

  it("changes when a version's media is replaced (E3.3 rendition cutover)", () => {
    const mp4: MediaLocator = { ...mkv, messageId: 27, fileUniqueId: "AgADmp4", fileSize: 1_007_441_962, mimeType: "video/mp4" };
    expect(locatorIdentity(mp4)).not.toBe(locatorIdentity(mkv));
  });

  it.each([
    ["movieVersionId", { movieVersionId: 2 }],
    ["chatId", { chatId: "-1009999999999" }],
    ["messageId", { messageId: 24 }],
    ["fileUniqueId", { fileUniqueId: "AgADother" }],
    ["fileSize", { fileSize: 1_004_462_879 }],
    ["mimeType", { mimeType: "video/mp4" }],
    ["mimeType (absent)", { mimeType: null }],
  ] satisfies [string, Partial<MediaLocator>][])("depends on %s", (_field, change) => {
    expect(locatorIdentity({ ...mkv, ...change })).not.toBe(locatorIdentity(mkv));
  });
});
