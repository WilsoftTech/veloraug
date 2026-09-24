# Velora UG

Streaming platform for Ugandan VJ-translated movies and series (Next.js App Router, TypeScript, Tailwind, Supabase). Supabase is the catalogue authority. VJs are first-class catalogue entities, and movies and series (seasons → episodes) are separate roots. Telegram is the planned private media origin and ingestion path. TMDB only enriches metadata and is never the catalogue authority. The public UI is still the legacy TMDB discovery app until Phase D replaces it. Read these before working here:

@AGENTS.md
@IMPLEMENTATION_ROADMAP.md

- `AGENTS.md` — engineering rules; always apply.
- `IMPLEMENTATION_ROADMAP.md` — what to build and in what order; finish a phase before starting the next. Use its identifiers (A1–A5, B1–B5, C–G) as canonical; `docs/PHASE_B_CATALOGUE_DESIGN.md` maps the historical `B-1`… checkpoint labels onto them.
- `DESIGN.md` — the visual system ("Cognitive Deep-Blue Glass"); authoritative for colour, type, spacing, radii and elevation. Read it before any UI work.
- `docs/Design prompt.md` — product and UX brief (screens, behaviour, structure) that applies `DESIGN.md` to a movie and TV product. If it disagrees with `DESIGN.md`, `DESIGN.md` wins.

Database changes go through new files in `supabase/migrations/` only; applied migrations are immutable. After any migration, run `npm run test:db` (local Supabase, pgTAP) and `npx supabase@2.117.0 db lint --local`.

Design tokens are implemented in `app/globals.css`; components use the semantic token names, never raw colours. The product name is **Velora UG**. Internal package, storage and environment names keep the original `velora` naming.
