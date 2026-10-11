// Prints the browser playback matrix as Markdown, from what `npm run test:browser`
// recorded in tests/browser/.results. Read-only: `node tests/browser/matrix.mjs`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const results = join(here, ".results");
const { fixtures } = JSON.parse(readFileSync(join(here, "fixtures", "manifest.json"), "utf8"));
const ORDER = ["chrome", "chrome-headed", "msedge", "msedge-headed", "chrome-software-decode", "chromium", "firefox", "firefox-headed", "webkit"];
const AUDIBLE_RMS = 0.01;

if (!existsSync(results)) {
  console.error("No results. Run `npm run test:browser` first.");
  process.exit(1);
}
const projects = readdirSync(results).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
const load = (project, file) => {
  const path = join(results, project, `${file}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
};

/** Audio as measured: the samples the element produced, or the decoder's own byte count where Web Audio is missing. */
function audio(result) {
  if (result.audioMeasured) return result.audioRms > AUDIBLE_RMS ? "yes" : "silent";
  if (typeof result.audioDecodedBytes === "number") return result.audioDecodedBytes > 0 ? "decoded, not measured" : "none decoded";
  return "not measurable";
}

function verdict(result) {
  if (result.harnessError) return "harness error";
  if (!result.metadata) return "no metadata";
  if (!result.playing) return "does not play";
  const sound = audio(result);
  const picture = result.firstFrame;
  const through = result.seeked && result.resumed;
  if (picture && sound === "yes") return through ? "plays" : "plays, seek fails";
  if (picture && sound === "silent") return through ? "video only, no audio" : "video only, seek fails";
  if (picture) return `video; audio ${sound}`;
  if (sound === "yes") return "audio only, no picture";
  return "no picture, no audio";
}

const yes = (value) => (value ? "yes" : "no");
const describe = (fixture) => `${fixture.container.toUpperCase()}${fixture.fastStart === false ? ", index at end" : ""} · ${fixture.video} · ${fixture.audio.join(" + ")}${fixture.subtitles.length ? ` · subtitles ${fixture.subtitles.join(", ")}` : ""}`;
const row = (cells) => `| ${cells.join(" | ")} |`;

console.log("### Browsers\n");
console.log(row(["Project", "Browser", "Version", "Headless", "Platform"]));
console.log(row(["---", "---", "---", "---", "---"]));
for (const project of projects) {
  const any = fixtures.map((fixture) => load(project, fixture.file)).find(Boolean);
  if (any) console.log(row([project, any.browserName, any.browserVersion, yes(any.headless), any.platform]));
}

console.log("\n### Result by fixture and browser\n");
console.log(row(["Fixture", "Content", ...projects]));
console.log(row(["---", "---", ...projects.map(() => "---")]));
for (const fixture of fixtures) {
  console.log(row([fixture.file, describe(fixture), ...projects.map((project) => {
    const record = load(project, fixture.file);
    return record ? verdict(record.result) : "not run";
  })]));
}

for (const project of projects) {
  console.log(`\n### ${project}: measurements\n`);
  console.log(row(["Fixture", "canPlayType", "Media Capabilities", "Metadata", "Metadata ms", "Playing ms", "First frame", "Audio", "Tone Hz", "Seek", "Resume", "Range requests", "Past byte 0", "Statuses", "Error"]));
  console.log(row(Array(15).fill("---")));
  for (const fixture of fixtures) {
    const record = load(project, fixture.file);
    if (!record) continue;
    const { result, requests } = record;
    const error = result.harnessError ?? (result.errorCode === null ? "" : `MediaError ${result.errorCode}${result.errorMessage ? `: ${result.errorMessage.replaceAll("|", "/")}` : ""}`);
    console.log(row([
      fixture.file, result.canPlayType || '""', result.mediaCapabilities, yes(result.metadata), result.metadataMs ?? "", result.playingMs ?? "", yes(result.firstFrame), audio(result), result.audioHz ?? "",
      yes(result.seeked), yes(result.resumed), requests.count, requests.startingPastZero, requests.statuses.join(", "), error,
    ]));
  }
}

// Startup cost of larger files (tests/browser/startup.spec.ts), when that opt-in suite was run.
const mib = (bytes) => (bytes / 1048576).toFixed(1);
const startup = projects.flatMap((project) => readdirSync(join(results, project)).filter((name) => name.startsWith("startup-")).sort().map((name) => JSON.parse(readFileSync(join(results, project, name), "utf8"))));
if (startup.length > 0) {
  console.log("\n### Startup cost of larger files\n");
  console.log(row(["Project", "File", "Size MiB", "Requests before metadata", "MiB sent before metadata", "Metadata ms", "MiB sent in total", "Seek to 60 s", "Resume", "Verdict"]));
  console.log(row(Array(10).fill("---")));
  for (const record of startup) {
    console.log(row([
      record.project, record.file, mib(record.sizeBytes), record.atMetadata ? record.atMetadata.requests : "never", record.atMetadata ? mib(record.atMetadata.bytes) : "",
      record.result.metadataMs ?? "", mib(record.atEnd.bytes), yes(record.result.seeked), yes(record.result.resumed), verdict(record.result),
    ]));
  }
}
