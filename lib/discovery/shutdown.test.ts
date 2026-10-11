import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Execute the host's actual signal registration and finally block offline.
// No listener import, database, Telegram client, child service or live signal.
const source = readFileSync(resolve("services/media-gateway/discovery.mts"), "utf8").replaceAll("\r\n", "\n");
const wiring = source.slice(source.indexOf("  const stop ="), source.indexOf("  const db ="));
const cleanup = source.slice(source.lastIndexOf("  } finally {") + "  } finally {".length, source.lastIndexOf("\n  }\n}"));

describe("persistent discovery shutdown", () => {
  it.each(["SIGTERM", "SIGINT"])("drains and releases the lease once when the library re-raises %s", async (signal) => {
    const process = new EventEmitter();
    const abort = new AbortController();
    let aborts = 0;
    abort.signal.addEventListener("abort", () => aborts++);
    let finishRelease!: () => void;
    const target = { release: vi.fn(() => new Promise<void>((done) => { finishRelease = done; })) };
    const reader = { stop: vi.fn(async () => {}) };
    const db = { close: vi.fn(async () => {}) };
    const server = { close: vi.fn(), closeAllConnections: vi.fn() };
    const log = vi.fn();
    const run = new Function("process", "abort", "target", "reader", "db", "server", "log", `${wiring}\nreturn async () => {${cleanup}\n};`);
    const finallyBlock = run(process, abort, target, reader, db, server, log) as () => Promise<void>;
    const library = () => { process.removeListener(signal, library); queueMicrotask(() => process.emit(signal)); };
    process.on(signal, library);
    process.emit(signal);
    const pending = finallyBlock();
    await Promise.resolve();
    // Persistent handler still exists while release is outstanding.
    expect(process.listenerCount(signal)).toBe(1);
    process.emit(signal);
    expect(aborts).toBe(1);
    expect(target.release).toHaveBeenCalledOnce();
    finishRelease();
    await pending;
    expect(target.release).toHaveBeenCalledOnce();
    expect(reader.stop).toHaveBeenCalledOnce();
    expect(db.close).toHaveBeenCalledOnce();
    expect(process.listenerCount("SIGTERM") + process.listenerCount("SIGINT")).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });
});
