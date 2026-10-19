import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Emergency publisher containment (AGENTS.md section 40). The contained
 * publisher and batch scripts are local and ignored; nothing tracked may start
 * them, name the suspended standing-approval reference, or record rights on its own.
 */
const CONTAINED = ["standing-approval-publisher", "publish-eight-originals", "resume-eight-originals", "verify-all-readiness", "readiness-verifier", "owner-standing-approval"];
const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0")
  .filter((path) => /\.(ts|tsx|mts|mjs|js|cjs|json|sql|ya?ml|sh|ps1|service)$|Dockerfile$/.test(path) && !path.endsWith("containment.test.ts"));

describe("emergency publisher containment", () => {
  it("no tracked code or configuration starts a contained script or uses the suspended reference", () => {
    const hits = tracked.filter((path) => { const text = readFileSync(path, "utf8"); return CONTAINED.some((name) => text.includes(name)); });
    expect(hits).toEqual([]);
  });
  it("only the reviewer's session commands record rights: no tracked script or service calls them", () => {
    const callers = tracked.filter((path) => !path.startsWith("supabase/") && !/\.test\.(ts|tsx)$/.test(path) && !path.startsWith("tests/") && !path.startsWith("scripts/checkpoint"))
      .filter((path) => /discovery_review_(clear|decide)_rights/.test(readFileSync(path, "utf8")));
    expect(callers).toEqual(["lib/discovery/database.ts"]);
  });
});
