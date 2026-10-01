/**
 * Development only (E3.4): warn in the terminal when the media gateway that
 * playback needs is not running. In the background, so startup never waits for
 * it or depends on it.
 */
export function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "development") return;
  void import("@/lib/playback/gateway-dev-check").then(({ warnIfGatewayDown }) => warnIfGatewayDown());
}
