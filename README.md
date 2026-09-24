# Velora UG

A streaming platform for Ugandan VJ-translated movies and series, built with Next.js (App Router), TypeScript, Tailwind CSS v4 and Supabase.

It is being migrated from the earlier Velora TMDB discovery app in phases (see [`IMPLEMENTATION_ROADMAP.md`](IMPLEMENTATION_ROADMAP.md)). The current state is described below. Anything planned is labelled as planned.

## Architecture

| Concern | Authority | Status |
| --- | --- | --- |
| Catalogue: movies, series → seasons → episodes, genres | **Supabase (PostgreSQL)**: what Velora UG offers is what is published there | Live (B5): home, Movies, Series, details, VJs and search all read the published catalogue through `lib/catalogue.ts` |
| VJs | First-class catalogue entities (`vjs`, with per-VJ `movie_versions` / `episode_versions`) | Live: VJ pages, VJ filters and "Available from" links. Poster badges are planned (Phase D) |
| Media origin | Telegram channels, ingested by separate movie/series bots | Ingestion and review tables exist (`private` schema). Bots, webhooks and playback are planned (Phases C and E) |
| Metadata | TMDB, for enrichment of ingested/approved records only, never catalogue authority | Normal browsing makes no TMDB request. Remaining uses: the artwork CDN for stored poster paths, and a temporary lookup describing legacy My List rows |
| Accounts | Supabase Auth, profiles, persistent My List (own-row RLS, 500-item cap, guest merge) | Live |
| Subscriptions / Mobile Money | Database plans, provider-verified payments | Planned (Phase F) |

Browser code never receives Telegram, payment, service-role or database secrets.

## Project documents

- [`AGENTS.md`](AGENTS.md): engineering rules
- [`IMPLEMENTATION_ROADMAP.md`](IMPLEMENTATION_ROADMAP.md): phases A–G
- [`DESIGN.md`](DESIGN.md): visual system
- [`docs/Design prompt.md`](docs/Design%20prompt.md): product/UX brief
- [`docs/VELORA_UG_SCHEMA_BASELINE.md`](docs/VELORA_UG_SCHEMA_BASELINE.md): catalogue schema decisions
- [`docs/PHASE_B_CATALOGUE_DESIGN.md`](docs/PHASE_B_CATALOGUE_DESIGN.md): Phase B decisions, validation and deployment
- [`docs/HOSTED_BOOTSTRAP_AUDIT.md`](docs/HOSTED_BOOTSTRAP_AUDIT.md): hosted database audit log

## Run

```bash
npm install
cp .env.example .env.local   # then fill in the values
npm run dev
```

- Supabase: set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. The catalogue lives there, so browsing needs them. For local development, point them at a local stack (`npx supabase@2.117.0 start`) and load the development-only fixtures with `npx supabase@2.117.0 db reset --local --sql-paths ./seeds/dev-catalogue.sql`. There is no sample catalogue: an empty catalogue shows empty states.
- TMDB: optional and server-only (`TMDB_ACCESS_TOKEN` or `TMDB_API_KEY`). It only describes legacy My List rows saved by TMDB id before B5.

## Layout

| Path | Purpose |
| --- | --- |
| `app/` | Routes: `/`, `/movies`, `/movies/[slug]`, `/series`, `/series/[slug]`, `/vjs`, `/vjs/[slug]`, `/search`, `/my-list`, `/account`, `/sign-in`, `/sign-up`. `/tv`, `/trending` and `/discover` redirect; `/[movie\|tv]/[id]` resolves old TMDB links through the catalogue |
| `components/` | Shared UI. `MovieCard` is the single poster card; `MovieListItem` is its row form |
| `lib/catalogue.ts` | Server-only Supabase catalogue reads (published-only), returning `types/catalogue.ts` |
| `lib/tmdb/` | Server-only TMDB transport, the artwork CDN loader, and the temporary legacy My List lookup. Public routes may not import it (`lib/catalogue-boundary.test.ts`) |
| `lib/watchlist*.ts` | My List: guest localStorage store and account server actions |
| `supabase/migrations/` | Database history. Applied migrations are immutable |
| `supabase/tests/database/` | pgTAP regression tests for RLS, grants and function hardening |
| `app/globals.css` | Semantic design tokens (light and dark) |

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` / `npm run build` | Develop / production build |
| `npm run lint` / `npm run typecheck` | Static checks |
| `npm test` | Vitest unit tests (`lib/**/*.test.ts`), including the TMDB boundary check |
| `npm run test:catalogue` | Resets the **local** database with the development fixtures, then runs the catalogue integration tests (`tests/integration/`) |
| `npm run test:db` | Rebuilds the **local** Supabase database from `supabase/migrations/`, then runs the pgTAP suite. Needs Docker and a running local stack (`npx supabase@2.117.0 start`). It never touches hosted |

Release gate from a fresh clone: `npm ci` → `npm run lint` → `npm run typecheck` → `npm run build` → `npm test` → `npm run test:db` → `npm run test:catalogue`.

Attribution: this product uses TMDB and the TMDB APIs but is not endorsed or certified by TMDB. The footer carries TMDB's required notice and logo; keep both wherever TMDB metadata or artwork is shown.
