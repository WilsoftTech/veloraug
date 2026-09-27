import { describe, expect, it } from "vitest";
import { GATEWAY_ERROR_CODES, GatewayError, gatewayCodeOf, publicError } from "@/lib/media-gateway/errors";
import { createLogger, formatLogLine } from "@/lib/media-gateway/log";

const NOW = new Date("2026-09-27T12:00:00Z");

describe("structured log redaction", () => {
  it("writes only allow-listed fields", () => {
    const secrets = {
      token: "v1.eyJhdWQiOiJ2ZWxvcmEifQ.c2ln",
      authorization: "Bearer v1.x.y",
      chatId: "-1001234567890",
      messageId: 23,
      accessHash: "8347562934857",
      fileReference: "AQIDBA",
      botToken: "1234567890:AAAbbbCCC",
      apiHash: "0123456789abcdef0123456789abcdef",
      session: "1BVtsOK8Bu...",
      databaseUrl: "postgresql://postgres:pw@host/db",
      error: new Error("FLOOD_WAIT_17 at channel -1001234567890"),
    };
    const line = formatLogLine("info", { event: "media_request", requestId: "r-1", movieVersionId: 1, status: 206, ...secrets } as never, NOW);
    expect(JSON.parse(line)).toEqual({ ts: NOW.toISOString(), level: "info", event: "media_request", requestId: "r-1", movieVersionId: 1, status: 206 });
    for (const value of ["v1.", "Bearer", "-100", "8347562934857", "AQIDBA", "AAAbbb", "0123456789abcdef", "1BVts", "postgres", "FLOOD"]) {
      expect(line).not.toContain(value);
    }
  });

  it("drops allow-listed string fields whose values are not identifier-like", () => {
    const line = formatLogLine("warn", { event: "x", code: "chat -1001234567890 message 23", requestId: "a b" }, NOW);
    expect(JSON.parse(line)).toEqual({ ts: NOW.toISOString(), level: "warn", event: "x" });
  });

  it("drops non-numeric numbers", () => {
    const line = formatLogLine("info", { event: "x", servedBytes: Number.NaN, latencyMs: 12.6 }, NOW);
    expect(JSON.parse(line)).toMatchObject({ latencyMs: 13 });
    expect(line).not.toContain("servedBytes");
  });

  it("writes one JSON line per event to the sink", () => {
    const lines: string[] = [];
    createLogger((line) => lines.push(line), () => NOW).error({ event: "e", code: "internal_error" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ level: "error", code: "internal_error" });
  });
});

describe("safe error serialization", () => {
  it("maps every code to a fixed status and a short public body", () => {
    for (const code of GATEWAY_ERROR_CODES) {
      const { status, body } = publicError(code);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(Object.keys(JSON.parse(body))).toEqual(["error"]);
      expect(body.length).toBeLessThan(64);
    }
  });

  it("hides which availability rule failed", () => {
    expect(publicError("version_unavailable")).toEqual(publicError("not_found"));
  });

  it("classifies anything unexpected as internal, never echoing its message", () => {
    const raw = new Error("FILE_REFERENCE_EXPIRED for document 5432 in chat -1001234567890");
    expect(gatewayCodeOf(raw)).toBe("internal_error");
    expect(publicError(gatewayCodeOf(raw)).body).toBe('{"error":"internal_error"}');
    expect(gatewayCodeOf(new GatewayError("flood_wait", { retryAfterSeconds: 5 }))).toBe("flood_wait");
    expect(new GatewayError("flood_wait").message).toBe("flood_wait");
  });

  it("distinguishes the required internal failure classes", () => {
    const required = [
      "authorization_invalid",
      "authorization_expired",
      "wrong_operation",
      "version_unavailable",
      "invalid_range",
      "range_not_satisfiable",
      "telegram_unavailable",
      "flood_wait",
      "mtproto_disconnected",
      "document_resolution_failed",
      "upstream_timeout",
      "internal_error",
    ];
    expect(GATEWAY_ERROR_CODES).toEqual(expect.arrayContaining(required));
    expect(publicError("range_not_satisfiable").status).toBe(416);
    expect(publicError("upstream_timeout").status).toBe(504);
  });
});
