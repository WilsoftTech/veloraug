import { readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fixtureSchema, fixturePorts } from "@/lib/discovery/fixtures";
import { openInbox } from "@/lib/discovery/store";
import { replayProvider, runReplay } from "@/lib/discovery/worker";

// Deliberately no --env-file, credential loading, live mode, upload or publication command.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--fixture") {
  console.error("Usage: npm run discovery:replay -- --fixture <synthetic JSON file>");
  process.exitCode = 2;
} else {
  const signal = new AbortController();
  const stop = () => signal.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const path = resolve(args[1]);
    if ((await stat(path)).size > 2 * 1024 * 1024) throw new Error("fixture_size_limit");
    const fixture = fixtureSchema.parse(JSON.parse(await readFile(path, "utf8")));
    const store = await openInbox(join(process.cwd(), ".velora-ingest", "discovery"), process.cwd(), fixture.channelId);
    await runReplay(store, replayProvider(fixture.updates), fixturePorts(fixture), { signal: signal.signal, now: () => new Date(), log: (metrics) => console.log(JSON.stringify(metrics)) });
  } catch {
    console.error(JSON.stringify({ event: "discovery_failure", code: "offline_replay_failed_inspect_fixture_or_inbox" }));
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  }
}
