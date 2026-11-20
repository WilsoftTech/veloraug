import { progressDeps } from "@/lib/playback/progress-deps";
import { createProgressHandlers } from "@/lib/playback/progress-route";

/** The signed-in viewer's movie progress (E3). Contract and checks: lib/playback/progress-route.ts. */
const handlers = createProgressHandlers(progressDeps);
export const GET = handlers.GET;
export const POST = handlers.POST;
