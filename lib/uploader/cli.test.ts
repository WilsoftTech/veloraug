import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

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
  return spawnSync(process.execPath, ["--import", "./scripts/ingest/register.mjs", "scripts/ingest/cli.mts", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", VELORA_INGEST_JOURNAL_DIR: journalDir },
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
