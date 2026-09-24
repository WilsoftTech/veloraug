# Velora UG

A streaming platform for Ugandan VJ-translated movies and series, built with Next.js (App Router), TypeScript, Tailwind CSS v4 and Supabase.

It is being migrated from the earlier Velora TMDB discovery app in phases (see [`IMPLEMENTATION_ROADMAP.md`](IMPLEMENTATION_ROADMAP.md)). The current state is described below. Anything planned is labelled as planned.

## Architecture

| Concern | Authority | Status |
| --- | --- | --- |
| Catalogue: movies, series → seasons → episodes, genres | **Supabase (PostgreSQL)**: what Velora UG offers is what is published there | Schema, published-only RLS and a server data layer (`lib/catalogue.ts`) exist. The public pages don't use them yet (Phase D) |
| VJs | First-class catalogue entities (`vjs`, with per-VJ `movie_versions` / `episode_versions`) | In the schema. VJ pages and badges are planned (Phase D) |
| Media origin | Telegram channels, ingested by separate movie/series bots | Ingestion and review tables exist (`private` schema). Bots, webhooks and playback are planned (Phases C and E) |
| Metadata | TMDB, for enrichment of ingested/approved records only, never catalogue authority | The current discovery UI still reads TMDB directly. It moves off TMDB in Phases B5/D |
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

- Supabase: set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Without them the app runs guest-only.
- TMDB: set `TMDB_ACCESS_TOKEN` (v4) or `TMDB_API_KEY` (v3). Both are server-only. Without either, a small built-in sample catalogue is served (`lib/tmdb/sample.ts`).

## Layout

| Path | Purpose |
| --- | --- |
| `app/` | Routes: `/`, `/movies`, `/tv`, `/trending`, `/discover`, `/search`, `/my-list`, `/account`, `/sign-in`, `/sign-up`, `/[movie\|tv]/[id]` |
| `components/` | Shared UI. `MovieCard` is the single poster card; `MovieListItem` is its row form |
| `lib/catalogue.ts` | Server-only Supabase catalogue reads (published-only), returning `types/catalogue.ts` |
| `lib/tmdb/` | Server-only TMDB access and mapping |
| `lib/watchlist*.ts` | My List: guest localStorage store and account server actions |
| `supabase/migrations/` | Database history. Applied migrations are immutable |
| `supabase/tests/database/` | pgTAP regression tests for RLS, grants and function hardening |
| `app/globals.css` | Semantic design tokens (light and dark) |

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` / `npm run build` | Develop / production build |
| `npm run lint` / `npm run typecheck` | Static checks |
| `npm run test:db` | Rebuilds the **local** Supabase database from `supabase/migrations/`, then runs the pgTAP suite. Needs Docker and a running local stack (`npx supabase@2.117.0 start`). It never touches hosted |

Release gate from a fresh clone: `npm ci` → `npm run lint` → `npm run typecheck` → `npm run build` → `npm run test:db`.

Attribution: this product uses TMDB and the TMDB APIs but is not endorsed or certified by TMDB. The footer carries TMDB's required notice and logo; keep both wherever TMDB metadata or artwork is shown.
