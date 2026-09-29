import { describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { canStreamMovieVersion, hasStreamingEntitlement, type EntitlementDeps } from "@/lib/playback/entitlement";

const USER: CurrentUser = { id: "0b8a3f0e-7d51-4c1f-9d1e-2f5a6b7c8d9e", email: "viewer@example.com" };
const ON_THE_HUNT = 1;

function deps(options: { entitled?: boolean; playable?: number[]; catalogueFails?: boolean } = {}) {
  const calls = { entitlement: 0, catalogue: 0 };
  const value: EntitlementDeps = {
    async hasStreamingEntitlement() {
      calls.entitlement += 1;
      return options.entitled ?? true;
    },
    async isMovieVersionPlayable(id) {
      calls.catalogue += 1;
      if (options.catalogueFails) throw new Error("Could not load the catalogue.");
      return (options.playable ?? [ON_THE_HUNT]).includes(id);
    },
  };
  return { value, calls };
}

describe("canStreamMovieVersion", () => {
  it("allows an entitled user to stream a playable version, bound to that user and version", async () => {
    const d = deps();
    expect(await canStreamMovieVersion(USER, ON_THE_HUNT, d.value)).toEqual({ allowed: true, movieVersionId: ON_THE_HUNT, subject: USER.id });
    expect(d.calls).toEqual({ entitlement: 1, catalogue: 1 });
  });

  it("requires authentication before any entitlement or catalogue work", async () => {
    const d = deps();
    expect(await canStreamMovieVersion(null, ON_THE_HUNT, d.value)).toEqual({ allowed: false, reason: "authentication_required" });
    expect(d.calls).toEqual({ entitlement: 0, catalogue: 0 });
  });

  it("denies a user without entitlement without consulting the catalogue", async () => {
    const d = deps({ entitled: false });
    expect(await canStreamMovieVersion(USER, ON_THE_HUNT, d.value)).toEqual({ allowed: false, reason: "not_entitled" });
    expect(d.calls.catalogue).toBe(0);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "1", null, undefined, { id: 1 }])("rejects the malformed version id %s before anything else", async (id) => {
    const d = deps();
    expect(await canStreamMovieVersion(USER, id, d.value)).toEqual({ allowed: false, reason: "invalid_version" });
    expect(await canStreamMovieVersion(null, id, d.value)).toEqual({ allowed: false, reason: "invalid_version" });
    expect(d.calls).toEqual({ entitlement: 0, catalogue: 0 });
  });

  it("reports every unplayable version (unknown, unpublished, Fuze) as the same 'unavailable'", async () => {
    const d = deps({ playable: [ON_THE_HUNT] });
    for (const id of [2, 3, 999_999_999]) {
      expect(await canStreamMovieVersion(USER, id, d.value)).toEqual({ allowed: false, reason: "unavailable" });
    }
  });

  it("propagates a catalogue failure instead of guessing", async () => {
    await expect(canStreamMovieVersion(USER, ON_THE_HUNT, deps({ catalogueFails: true }).value)).rejects.toThrow("Could not load the catalogue.");
  });
});

describe("current access policy (pre-Phase F)", () => {
  it("entitles every signed-in user", async () => {
    expect(await hasStreamingEntitlement(USER)).toBe(true);
    expect(await hasStreamingEntitlement({ id: "another-user", email: null })).toBe(true);
  });

  it("never entitles an identity without a user id", async () => {
    expect(await hasStreamingEntitlement({ id: "", email: null })).toBe(false);
  });
});
