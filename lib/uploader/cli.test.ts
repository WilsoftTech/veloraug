import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeFingerprint } from "@/lib/ingestion/fingerprint";
import { parseFilename } from "@/lib/ingestion/parser";
import { buildUploadCaption } from "@/lib/ingestion/telegram";
import { newJournalEntry, openJournal } from "@/lib/uploader/journal";
import type { SourceFingerprint } from "@/types/ingestion";

/**
 * Runs the real CLI entry on plain Node (type stripping + register.mjs), the
 * way `npm run ingest` does. Vitest transpiles fully, so only this catches
 * TypeScript syntax Node cannot strip. The environment is empty apart from a
 * temporary journal: no Telegram, TMDB or Supabase configuration, no network.
 */
const ROOT = resolve(__dirname, "../..");
const journalDir = mkdtempSync(join(tmpdir(), "velora-cli-"));
afterAll(() => rmSync(journalDir, { recursive: true, force: true }));

function cli(...args: string[]) {
  return cliWith({}, ...args);
}

function cliWith(env: Record<string, string>, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", "./scripts/ingest/register.mjs", "scripts/ingest/cli.mts", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", VELORA_INGEST_JOURNAL_DIR: journalDir, ...env },
  });
}

describe("ingest CLI on plain Node", () => {
  it("loads every module and runs a read-only command", () => {
    const run = cli("status");
    expect(run.stderr).not.toMatch(/ERR_|SyntaxError/);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("entries: 0");
  });

  it("refuses a real upload or resume in C2A.1, before reading any configuration", () => {
    for (const command of ["upload", "resume"]) {
      const run = cli(command, "--execute");
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("real Telegram uploads are disabled in code until C2B");
    }
  });

  it("checkpoint validates its input and needs the channel configuration; it never calls Telegram", () => {
    expect(cli("checkpoint", "--kind", "movie", "--message-id", "0").stderr).toContain("--message-id must be a positive message id");
    expect(cli("checkpoint", "--message-id", "5").stderr).toContain("--kind movie|series is required");
    const unconfigured = cli("checkpoint", "--kind", "movie", "--message-id", "5", "--execute");
    expect(unconfigured.status).toBe(1);
    expect(unconfigured.stderr).toContain("the Telegram configuration (channel ids) is required");
  });
});

/**
 * Selection fixture: each file's journal fingerprint is its real sf1 value (the
 * CLI recomputes it before any upload), ordered A < B < C as the journal lists them.
 */
const FIXTURE = await (async () => {
  const files = ["Alpha.2001.VJ.Junior.mkv", "Bravo.2002.VJ.Junior.mkv", "Charlie.2003.VJ.Junior.mkv"];
  const sf1 = (content: string) => computeFingerprint(content.length, async (offset, length) => new TextEncoder().encode(content).subarray(offset, offset + length));
  const pairs = await Promise.all(files.map(async (name) => [await sf1(name), name] as const));
  return { ordered: pairs.map(([fingerprint]) => fingerprint).sort(), names: Object.fromEntries(pairs) as Record<string, string> };
})();

describe("upload --fingerprint on plain Node (C2B.2C.2)", () => {
  // Fake credentials: the right shape, never real.
  const MOVIE_TOKEN = "1111111:AAAAmovieFAKEtokenFAKEtokenFAKEtok";
  const MOVIES = -1001111111111;
  const TELEGRAM = {
    TELEGRAM_BOT_API_URL: "http://127.0.0.1:9",
    TELEGRAM_MOVIES_BOT_TOKEN: MOVIE_TOKEN,
    TELEGRAM_SERIES_BOT_TOKEN: "2222222:BBBBseriesFAKEtokenFAKEtokenFAKEto",
    TELEGRAM_MOVIES_CHANNEL_ID: String(MOVIES),
    TELEGRAM_SERIES_CHANNEL_ID: "-1002222222222",
    TELEGRAM_BOT_API_LOCAL_BOTS: "movie",
    TELEGRAM_MOVIES_BOT_ID: "1111111",
    TELEGRAM_MOVIES_BOT_USERNAME: "fake_movies_bot",
  };
  const [A, B, C] = FIXTURE.ordered;
  const names = FIXTURE.names;
  const dir = mkdtempSync(join(tmpdir(), "velora-cli-select-"));
  const media = mkdtempSync(join(tmpdir(), "velora-cli-media-"));
  const run = (env: Record<string, string>, ...args: string[]) => cliWith({ VELORA_INGEST_JOURNAL_DIR: dir, ...env }, "upload", ...args);
  const snapshot = () => readdirSync(dir).sort().map((name) => `${name}:${readFileSync(join(dir, name), "utf8")}`);

  beforeAll(async () => {
    const journal = await openJournal(dir);
    for (const [fingerprint, fileName] of Object.entries(names)) {
      const absolutePath = join(media, fileName);
      writeFileSync(absolutePath, fileName);
      await journal.put({
        ...newJournalEntry({ fingerprint: fingerprint as SourceFingerprint, kind: "movie", intendedChannelId: MOVIES, fileName, relativePath: fileName, absolutePath, sizeBytes: fileName.length, modifiedAtMs: 1, discoveryKey: "e".repeat(64) }, new Date("2026-09-27T00:00:00Z")),
        plan: { action: "upload", stopReasons: [] },
      });
    }
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(media, { recursive: true, force: true });
  });

  it("a dry run selects exactly that entry, runs the offline preflight, and writes nothing", () => {
    const before = snapshot();
    const result = run(TELEGRAM, "--fingerprint", B);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`selected     ${B}  (exact match, 1 of 3 journal entries)`);
    expect(result.stdout).toContain(names[B]);
    expect(result.stdout).not.toContain(names[A]);
    expect(result.stdout).not.toContain(names[C]);
    expect(result.stdout).toContain("destination  movie bot -> the configured movie channel (local Bot API)");
    expect(result.stdout).toContain("preflight    ok (sendDocument by local path)");
    expect(result.stdout).toContain("source       current bytes fingerprint to the selected value (exact match)");
    const parse = parseFilename(names[B]);
    expect(result.stdout).toContain(buildUploadCaption({ kind: "movie", title: parse.title, year: parse.year, vjName: parse.vjText, season: null, episode: null, fingerprint: B }).split("\n").join(" | "));
    expect(result.stdout).toContain("would upload this entry only");
    // Nothing identifying the bot or the channel, and no local directory.
    for (const secret of [MOVIE_TOKEN, "1111111", String(MOVIES), media]) expect(result.stdout + result.stderr).not.toContain(secret);
    expect(snapshot()).toEqual(before);
  });

  it("the dry run is independent of journal order: the last-sorting entry is selected just the same", () => {
    const result = run(TELEGRAM, "--fingerprint", C, "--limit", "1");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`selected     ${C}`);
    expect(result.stdout).not.toContain(names[A]);
  });

  it("without configuration the dry run still selects, and says it would not upload", () => {
    const result = run({}, "--fingerprint", B);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`selected     ${B}`);
    expect(result.stdout).toContain("would not upload (telegram_config_invalid)");
  });

  it("--execute with the gate off refuses after selection and before any configuration, server or Telegram use", () => {
    const before = snapshot();
    const result = run(TELEGRAM, "--fingerprint", B, "--execute");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("real Telegram uploads are disabled in code until C2B");
    expect(snapshot()).toEqual(before);
  });

  it("refuses bad selections with a code and a fixed message, never echoing the value", () => {
    const secretPath = "C:\\Private\\Library\\Secret.Title.2020.mkv";
    const cases: Array<[string[], string]> = [
      [["--fingerprint", secretPath], "fingerprint_invalid"],
      [["--fingerprint", MOVIE_TOKEN], "fingerprint_invalid"],
      [["--fingerprint", B.toUpperCase()], "fingerprint_invalid"],
      [["--fingerprint", `sf1-${"e".repeat(64)}`], "fingerprint_not_found"],
      [["--fingerprint", B, "--fingerprint", C], "fingerprint_repeated"],
      [["--fingerprint", B, "--limit", "2"], "limit_conflicts_with_fingerprint"],
      [["--fingerprint", B, "--kind", "series"], "fingerprint_kind_mismatch"],
    ];
    for (const [args, code] of cases) {
      for (const execute of [[], ["--execute"]]) {
        const result = run(TELEGRAM, ...args, ...execute);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`error: ${code}:`);
        expect(result.stderr).toContain("Nothing was sent.");
        expect(result.stderr).not.toContain(secretPath);
        expect(result.stderr).not.toContain(MOVIE_TOKEN);
      }
    }
  });

  it("a same-size change to the selected file is caught by the dry run's revalidation; the journal is not updated", () => {
    const path = join(media, names[C]);
    const original = readFileSync(path, "utf8");
    const before = snapshot();
    try {
      writeFileSync(path, `X${original.slice(1)}`);
      const result = run(TELEGRAM, "--fingerprint", C);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("preflight    ok (sendDocument by local path)");
      expect(result.stdout).toContain("source       refused: source_fingerprint_changed");
      expect(result.stdout).toContain("would not upload (source_fingerprint_changed)");
      expect(result.stdout + result.stderr).not.toContain(media);
      expect(snapshot()).toEqual(before);
    } finally {
      writeFileSync(path, original);
    }
  });

  it("a missing value is a clean usage error, not a stack trace", () => {
    const result = run({}, "--fingerprint");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: Option '--fingerprint <value>' argument missing");
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });
});
