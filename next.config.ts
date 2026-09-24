import type { NextConfig } from "next";

// Without these, accounts silently vanish from a deploy. Only enforced for real
// production deploys so a fresh clone (or CI) still builds as a guest-only app.
if (
  process.env.VERCEL_ENV === "production" &&
  !(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
) {
  throw new Error("Production build needs NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.");
}

const nextConfig: NextConfig = {
  // Pre-B5 TMDB browse routes. The catalogue now lives at /movies and /series.
  // Legacy /movie/:id and /tv/:id detail links resolve in app/[mediaType]/[id].
  async redirects() {
    return [
      { source: "/tv", destination: "/series", permanent: true },
      { source: "/trending", destination: "/", permanent: true },
      { source: "/discover", has: [{ type: "query", key: "type", value: "tv" }], destination: "/series", permanent: true },
      { source: "/discover", destination: "/movies", permanent: true },
    ];
  },
  images: {
    // Catalogue records store TMDB artwork paths (metadata of an approved Velora
    // record, not a catalogue decision). TMDB serves pre-sized images, so a custom loader
    // maps the requested width to the nearest TMDB size instead of paying for
    // a second round of optimization.
    loader: "custom",
    loaderFile: "./lib/tmdb/image-loader.ts",
    // Match the widths TMDB actually serves (see image-loader.ts) so srcset
    // candidates map 1:1 onto CDN sizes instead of overshooting to the next one.
    deviceSizes: [640, 780, 1280, 1920],
    imageSizes: [92, 154, 185, 342, 500],
  },
};

export default nextConfig;
