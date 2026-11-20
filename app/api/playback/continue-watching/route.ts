import { progressDeps } from "@/lib/playback/progress-deps";
import { createContinueWatchingHandler } from "@/lib/playback/progress-route";

/** The signed-in viewer's unfinished movies (E5). Contract and checks: lib/playback/progress-route.ts. */
export const GET = createContinueWatchingHandler(progressDeps);
