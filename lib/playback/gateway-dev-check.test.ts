import { describe, expect, it, vi } from "vitest";
import { warnIfGatewayDown } from "@/lib/playback/gateway-dev-check";

const SECRET = "c2VjcmV0LXZhbHVlLXRoYXQtbXVzdC1uZXZlci1iZS1wcmludGVk";
const ENV = { MEDIA_GATEWAY_PUBLIC_ORIGIN: "http://127.0.0.1:8787", MEDIA_GATEWAY_TOKEN_SECRET: SECRET };

describe("warnIfGatewayDown", () => {
  it("warns once, naming the origin and the start command, when the gateway is unreachable", async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await warnIfGatewayDown(ENV, fetchImpl, warn)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("http://127.0.0.1:8787");
    expect(warn.mock.calls[0][0]).toContain("npm run gateway:dev");
    expect(warn.mock.calls[0][0]).not.toContain(SECRET);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("http://127.0.0.1:8787/healthz");
  });

  it("warns when the gateway answers with an error", async () => {
    const warn = vi.fn();
    expect(await warnIfGatewayDown(ENV, vi.fn(async () => new Response("", { status: 502 })) as unknown as typeof fetch, warn)).toBe(true);
  });

  it("stays quiet when the gateway is up", async () => {
    const warn = vi.fn();
    expect(await warnIfGatewayDown(ENV, vi.fn(async () => Response.json({ status: "ok" })) as unknown as typeof fetch, warn)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does nothing, and contacts nothing, when playback is not configured", async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    for (const origin of [undefined, "", "not a url", "http://media.velora.example"]) {
      expect(await warnIfGatewayDown({ MEDIA_GATEWAY_PUBLIC_ORIGIN: origin }, fetchImpl, warn)).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
