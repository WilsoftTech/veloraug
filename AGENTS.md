<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AGENTS.md — Velora Engineering Rules

## 1. Project Goal

Build a fast, lightweight, responsive movie discovery web application that can later evolve into a mobile application with minimal architectural changes.

The application must prioritize:

* Performance
* Mobile-first responsive design
* Component reuse
* Maintainability
* Accessibility
* Type safety
* Minimal dependencies
* Simple architecture
* SEO
* Future React Native / Expo compatibility

Do not over-engineer the application.

---

## 2. Core Technology Stack

### Web

* Next.js App Router
* React
* TypeScript
* Tailwind CSS
* shadcn/ui where an appropriate primitive is needed

### Data

* TMDB API for movie/TV metadata
* Supabase for PostgreSQL, authentication, and application data
* Drizzle ORM where server-side database access benefits from an ORM
* Zod for runtime validation

### State and Data Fetching

Prefer built-in React and Next.js capabilities first.

Use:

* Server Components for server-renderable data
* URL/search params for shareable navigation/filter state
* Local React state for local UI state
* TanStack Query only where client-side server-state synchronization is genuinely useful
* Zustand only when state must be shared across unrelated client components and simpler approaches are inadequate

Do not introduce Redux.

### Forms

* React Hook Form when forms are sufficiently complex
* Zod for validation

For very small forms, prefer simpler native/React approaches rather than adding unnecessary abstraction.

### Testing

* Vitest for unit tests
* React Testing Library for component behavior where needed
* Playwright for critical user flows

### Infrastructure

* Vercel for web deployment
* Sentry for production error monitoring when production monitoring is introduced
* PostHog for product analytics when analytics are required
* GitHub Actions for CI

---

# 3. Primary Engineering Rule: Reuse Before Creating

Before creating ANY new component, hook, utility, helper, type, schema, service, or abstraction:

1. Search the existing codebase.
2. Identify whether equivalent or similar functionality already exists.
3. Reuse the existing implementation whenever practical.
4. Extend an existing implementation when the new requirement is a natural extension.
5. Create something new only when reuse or extension would produce unclear or tightly coupled code.

DO NOT recreate existing components.

DO NOT create duplicate components with slightly different names.

Bad:

```text
MovieCard.tsx
MovieCardNew.tsx
MovieCardV2.tsx
PopularMovieCard.tsx
TrendingMovieCard.tsx
SearchMovieCard.tsx
```

Preferred:

```text
MovieCard.tsx
```

with appropriate composition or small, meaningful variants when genuinely necessary.

Before adding a component, explicitly inspect:

```text
components/
app/
features/
hooks/
lib/
utils/
types/
```

and any other relevant project directories.

---

# 4. Modify Existing Components Carefully

When functionality already exists:

Prefer modifying, composing, or extending the existing implementation rather than replacing it.

Do not rewrite an entire component to make a small change.

Preserve existing:

* Behavior
* Props/contracts
* Accessibility
* Styling conventions
* Tests
* Responsive behavior

unless the task specifically requires changing them.

Make the smallest coherent change that satisfies the requirement.

---

# 5. Component Design

Components should have clear responsibilities.

Prefer:

```tsx
<MovieCard movie={movie} />
```

over large duplicated markup.

Use composition where appropriate.

Example:

```tsx
<MovieSection
  title="Popular"
  movies={popularMovies}
/>

<MovieSection
  title="Trending"
  movies={trendingMovies}
/>
```

instead of implementing two almost identical sections.

Avoid premature abstraction.

Do not create a reusable abstraction for code used once unless it clearly represents an architectural boundary or substantially improves readability.

The goal is:

**reuse without abstraction bloat.**

---

# 6. Lightweight Application Requirement

Application weight is a first-class constraint.

Before installing ANY dependency:

1. Check whether the project already has functionality that solves the problem.
2. Check whether React, Next.js, Tailwind, browser APIs, or existing dependencies can solve it.
3. Evaluate whether the dependency is justified.
4. Prefer small, actively maintained packages.
5. Avoid overlapping libraries.

Do not install packages merely to save a few lines of code.

Avoid large libraries for trivial functionality.

Examples:

Do not install a utility library to perform simple array/string operations already supported by JavaScript.

Do not install a date library unless date requirements justify it.

Do not install multiple icon libraries.

Do not install multiple state-management libraries.

Do not install another UI framework when Tailwind/shadcn already solves the requirement.

Every dependency increases:

* Bundle size
* Maintenance burden
* Security surface
* Upgrade complexity

Keep dependencies minimal.

---

# 7. Server Components First

In the Next.js App Router, components are Server Components by default.

Keep them that way unless browser-side interactivity is required.

Do NOT add:

```tsx
"use client";
```

without a concrete reason.

Client Components are appropriate for things such as:

* Interactive search inputs
* Menus
* Modals
* User interactions
* Client-side state
* Browser APIs

Keep Client Component boundaries as small as practical.

Bad:

```text
Entire page
└── "use client"
```

Preferred:

```text
Server Page
├── Server-rendered content
├── MovieGrid
└── SearchControls ("use client")
```

Do not move server-renderable work to the browser unnecessarily.

---

# 8. Mobile-First Responsive Design

All interfaces must be designed mobile-first.

Start with small screens and progressively enhance for larger screens.

Support at minimum:

* Small phones
* Large phones
* Tablets
* Laptops
* Desktop displays

Avoid fixed-width layouts.

Prefer responsive Tailwind utilities.

Example:

```tsx
className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
```

Exact breakpoints should be chosen according to the component and design rather than blindly copied.

---

# 9. Touch-First Interaction

The application will eventually become a mobile application.

Interactions must therefore work naturally with touch.

Do not depend on:

* Hover
* Right-click
* Tiny click targets
* Mouse-only interactions

Hover effects may enhance desktop behavior but must never be required to access functionality.

Buttons and interactive elements should have comfortable touch targets.

---

# 10. Future Mobile Architecture

The planned native application stack is:

```text
Expo
React Native
TypeScript
```

Potential shared packages may eventually include:

```text
packages/
├── api/
├── types/
├── validation/
├── utils/
└── config/
```

Web and native UI components do NOT need to be identical.

Share:

* Types
* Validation schemas
* API contracts
* Business logic
* Utilities
* Constants

Do not tightly couple business logic to Next.js components.

---

# 11. Progressive Web App Compatibility

The web application should remain compatible with becoming a PWA.

Avoid architectural decisions that unnecessarily prevent:

* Installation
* App manifests
* Service workers
* Offline caching where appropriate
* Mobile home-screen usage

Do not implement complex offline behavior unless explicitly requested.

---

# 12. Data Fetching

Prefer server-side fetching for initial page content where appropriate.

TMDB secrets must never be exposed to browser bundles.

Never expose private API credentials using `NEXT_PUBLIC_*`.

Keep secrets server-side.

Prefer centralized TMDB access rather than scattering raw TMDB requests throughout the application.

Example:

```text
lib/
└── tmdb/
    ├── client.ts
    ├── movies.ts
    └── types.ts
```

The exact structure should remain proportional to project complexity.

Do not create unnecessary files merely to match this example.

---

# 13. API Design

Important business functionality should remain usable by future clients such as:

```text
Next.js Web
Expo Mobile
```

Do not unnecessarily bind core business logic to presentation components.

Keep API contracts consistent and typed.

Validate external input using Zod where runtime validation is necessary.

Never trust client-provided data.

---

# 14. Database

Use PostgreSQL through Supabase.

Potential domain entities include:

```text
users
profiles
watchlists
watchlist_items
favorites
reviews
ratings
search_events
```

Do not create database tables until required by actual product functionality.

Avoid storing TMDB data unnecessarily.

When possible, store stable external identifiers such as:

```text
tmdb_movie_id
```

and application-specific user data rather than duplicating the entire TMDB catalogue.

### Migration privilege invariant

Every migration that creates or replaces a table, sequence, view, materialized view, or function must explicitly audit and establish its privileges.

Never rely on PostgreSQL/Supabase default privileges. Supabase's defaults in `public` grant `anon` and `authenticated` full access to new tables, sequences, and functions.

* Objects not intended for direct client access must explicitly revoke unintended privileges from `PUBLIC`, `anon`, and `authenticated`.
* Grant only what the app uses, as narrowly as possible.
* Functions must also be reviewed for `SECURITY INVOKER` vs `SECURITY DEFINER`, a pinned `search_path` (prefer `''` with schema-qualified objects), `EXECUTE` privileges, and caller-controlled dynamic SQL.

Applied migrations are immutable history. Change the database only through a new migration.

---

# 15. TypeScript Rules

Use strict TypeScript.

Avoid:

```ts
any
```

unless there is a documented and unavoidable reason.

Prefer explicit domain types.

Example:

```ts
interface Movie {
  id: number;
  title: string;
  posterPath: string | null;
  releaseDate: string;
}
```

Reuse existing types.

Do not redefine the same domain object in multiple files.

Use `unknown` instead of `any` when data has not yet been validated.

---

# 16. Styling

Use Tailwind CSS.

Reuse existing:

* Design tokens
* Spacing conventions
* Typography
* Components
* Layout patterns

Avoid arbitrary values when standard Tailwind values work.

Bad:

```tsx
className="mt-[13px] w-[347px]"
```

Preferred:

```tsx
className="mt-3 w-full"
```

Arbitrary values are acceptable when required by the design, but should not become the default.

---

# 17. Images

Movie applications are image-heavy, so image performance is critical.

Use Next.js image optimization where appropriate.

Always consider:

* Correct dimensions
* Responsive `sizes`
* Lazy loading
* Poster aspect ratios
* Placeholder/fallback behavior
* Avoiding layout shifts

Do not load unnecessarily large TMDB images for small cards.

Choose an image size appropriate to its rendered dimensions.

Above-the-fold priority images should be limited to genuinely important content.

---

# 18. Performance

Performance is a product requirement.

Avoid unnecessary:

* JavaScript
* Client Components
* Dependencies
* Network requests
* Re-renders
* Database queries
* Large images
* Animations
* Hydration

Prefer HTML/CSS over JavaScript for purely visual behavior.

Use dynamic imports only when they provide a meaningful benefit.

Do not optimize blindly; measure when performance work becomes significant.

---

# 19. Animations

Keep animations subtle and lightweight.

Prefer CSS/Tailwind transitions.

Do not add a large animation library unless the product requirement genuinely needs capabilities CSS cannot reasonably provide.

Respect:

```css
prefers-reduced-motion
```

where appropriate.

---

# 20. Accessibility

Accessibility is required.

Use semantic HTML.

Prefer:

```html
button
nav
main
section
article
header
footer
```

instead of clickable generic `<div>` elements.

Interactive elements must support keyboard navigation.

Images require appropriate alternative text.

Inputs require labels.

Dialogs, menus, dropdowns, and similar components should use accessible primitives such as those provided by shadcn/Radix where appropriate.

Maintain sufficient color contrast.

---

# 21. SEO

Movie detail pages should be indexable where appropriate.

Use Next.js metadata APIs.

Movie pages should support metadata such as:

```text
title
description
Open Graph image
canonical URL
```

Do not move SEO-relevant content entirely into client-side rendering.

---

# 22. State Management

Use the simplest appropriate state mechanism.

Preferred order:

```text
Server state / Server Components
        ↓
URL state
        ↓
Local React state
        ↓
Context where appropriate
        ↓
TanStack Query for complex client server-state
        ↓
Zustand for genuine shared client state
```

Do not create global state for data that belongs to one component.

Do not duplicate server data into global stores without a concrete reason.

---

# 23. Search

Search should be efficient.

When implementing live search:

* Debounce requests where appropriate
* Avoid requests for meaningless empty queries
* Cancel or ignore stale requests
* Provide loading feedback
* Handle errors
* Handle empty results
* Keep mobile keyboard behavior in mind

Do not create excessive TMDB requests on every keystroke.

---

# 24. Loading and Error States

Every asynchronous feature must consider:

```text
loading
success
empty
error
```

Use reusable skeleton/loading components when they already exist.

Do not create a different loading implementation for every page.

Use Next.js:

```text
loading.tsx
error.tsx
not-found.tsx
```

where they provide useful route-level behavior.

---

# 25. Error Handling

Do not silently swallow errors.

Avoid:

```ts
try {
  // ...
} catch {}
```

Handle errors intentionally.

Do not expose sensitive internal errors to users.

Log useful diagnostic information server-side where appropriate.

---

# 26. Authentication

Authentication will use Supabase Auth unless the architecture is explicitly changed.

Authentication logic should support future web and mobile clients.

Do not scatter authentication checks throughout unrelated UI code.

Centralize authorization rules where practical.

Never rely solely on hiding UI elements for authorization.

Server/database authorization remains authoritative.

---

# 27. Security

Never expose:

* TMDB secrets
* Supabase service-role keys
* Database credentials
* Private API keys

Validate input.

Apply authorization server-side.

Use environment variables for secrets.

Never commit `.env` files containing secrets.

Only variables intentionally safe for browsers may use:

```text
NEXT_PUBLIC_
```

---

# 28. Testing Strategy

Do not test implementation details unnecessarily.

Prioritize important behavior.

Critical Playwright flows should eventually cover:

```text
Homepage loads
        ↓
Movies display
        ↓
User searches
        ↓
Results display
        ↓
User opens movie
        ↓
Movie detail loads
```

Authenticated flows should later cover:

```text
Sign in
   ↓
Add movie to watchlist
   ↓
Open watchlist
   ↓
Movie appears
   ↓
Remove movie
```

When fixing a regression, add or update a test when practical.

---

# 29. Before Writing Code

For every task:

1. Read the request carefully.
2. Inspect the relevant existing code.
3. Search for reusable components/utilities/hooks/types.
4. Understand current architecture and conventions.
5. Determine the smallest coherent change.
6. Only then implement.

Do not immediately generate new files.

---

# 30. Before Creating a New File

Ask:

```text
Does something equivalent already exist?
        │
       Yes
        ↓
Can it be reused?
        │
       Yes → reuse it
        │
       No
        ↓
Can it be safely extended?
        │
       Yes → extend it
        │
       No
        ↓
Create a new implementation
```

New files must have a clear responsibility.

---

# 31. Before Installing a Package

Ask:

```text
Can existing code solve this?
        ↓
Can React solve this?
        ↓
Can Next.js solve this?
        ↓
Can Tailwind/CSS solve this?
        ↓
Can browser APIs solve this?
        ↓
Is an existing dependency already capable?
        ↓
Is the new dependency still justified?
```

Only then install it.

Explain the reason for any significant new dependency.

---

# 32. Refactoring Rules

Do not perform unrelated large refactors while implementing a feature.

Avoid changing unrelated files.

Avoid renaming public APIs unnecessarily.

Do not rewrite working code merely because another style is preferred.

Refactor when it:

* Removes meaningful duplication
* Fixes a design problem
* Improves maintainability
* Is required for the requested feature

Keep refactors scoped.

---

# 33. File and Folder Discipline

Do not create excessive directories.

Do not create one-line wrapper files without a clear reason.

Keep related functionality together.

As complexity grows, prefer feature/domain organization over uncontrolled global folders.

Example:

```text
features/
└── watchlist/
    ├── components/
    ├── actions/
    ├── schemas.ts
    └── types.ts
```

Only introduce feature folders when the feature has enough complexity to justify them.

---

# 34. Code Quality

Code should be:

* Readable
* Typed
* Testable
* Small enough to understand
* Consistent with the existing project
* Free from unnecessary abstractions

Prefer descriptive names.

Avoid comments that merely repeat the code.

Comment decisions and non-obvious constraints rather than obvious implementation details.

---

# 35. Do Not Over-Engineer

Do NOT introduce the following unless a concrete requirement justifies them:

* Redux
* GraphQL
* Microservices
* Kubernetes
* Complex event systems
* Multiple databases
* Custom design systems
* Large abstraction layers
* Repository/service patterns everywhere
* Premature caching infrastructure
* Redis solely because it may be useful someday

Solve today's problem while preserving reasonable future options.

---

# 36. Agent Change Discipline

When making changes:

* Inspect before editing.
* Prefer surgical modifications.
* Preserve working functionality.
* Reuse existing code.
* Avoid duplicate implementations.
* Avoid unrelated formatting changes.
* Avoid changing files unrelated to the task.
* Do not delete working functionality unless explicitly required.

After implementation:

1. Check TypeScript.
2. Run relevant linting.
3. Run relevant tests.
4. Run/build the application when appropriate.
5. Check for obvious responsive regressions.
6. Check for duplicated code introduced by the change.
7. Check whether unnecessary dependencies were added.
8. Review the final diff.

Fix problems introduced by the change before considering the task complete.

---

# 37. Agent Decision Priority

When multiple solutions are possible, prioritize in this order:

1. Correctness
2. Existing project conventions
3. Reuse
4. Simplicity
5. Performance
6. Accessibility
7. Maintainability
8. Mobile compatibility
9. Developer convenience

Do not trade substantial runtime performance or maintainability for minor developer convenience.

---

# 38. Definition of Done

A feature is not complete merely because it visually works.

Before marking work complete, verify:

* Existing components were reused where appropriate.
* No unnecessary duplicate component was introduced.
* No unnecessary dependency was installed.
* TypeScript passes.
* Relevant tests pass.
* The implementation works on mobile layouts.
* The implementation works on desktop layouts.
* Touch interactions work.
* Loading/error/empty states are handled where relevant.
* Accessibility has been considered.
* Secrets remain server-side.
* Images are appropriately optimized.
* Client-side JavaScript was kept minimal.
* No obvious regression was introduced.
* The final implementation is simpler than reasonable alternatives.

---

# 39. Core Principle

When implementing any feature, prefer:

```text
REUSE
  ↓
COMPOSE
  ↓
EXTEND
  ↓
CREATE
```

in that order.

And prefer:

```text
PLATFORM FEATURES
        ↓
EXISTING DEPENDENCIES
        ↓
SMALL CUSTOM IMPLEMENTATION
        ↓
NEW DEPENDENCY
```

in that order.

Velora should remain fast, lightweight, responsive, understandable, and easy to evolve into a native mobile application.

---

# 40. Emergency Publisher Containment (2026-10-17)

The prior standing owner approval is suspended. It is not sufficient evidence of
any title's distribution rights. Do not reactivate the local standing-approval
publisher or automatic rights clearance, approval, transfer, or publication
without a separate authorization decision. Keep
`.velora-ingest/standing-approval.pause` in place. Do not remove the containment
entry-point guards from the quarantined local operator scripts.

The current task permits local legacy-media fixes, offline tests, disposable
local database validation, read-only hosted audits, and live Telegram media
verification for the movie files covered by the current integrity and streaming
readiness audit. This verification authorization was granted by the owner on
2026-10-18. It permits reading and downloading existing Telegram media into
private local staging, hashing and fully decoding the files, checking streaming
layout and seek decoding, and recording verification claims, results, and
failures through the existing fenced verification commands. Preserve existing
identity prerequisites, leases, source bindings, and validation rules; do not
guess or automatically confirm film or VJ identity.

This verification-only authorization does not permit rights clearance, publication approval,
media uploads or transfers to Telegram, publication, hosted migrations,
deployment, push, listener rebuild or restart, or restarting the contained
batches. Use the existing explicit verification path; keep the pause marker and
quarantined entry-point guards intact. A clean complete decode is still required
for verified integrity; errors at the end of a file do not pass.

On 2026-10-18, the owner separately authorized applying only
`20261018072045_media_verification_on_upload.sql` to hosted after backup and
validation, and enabling its separate automatic media-verification worker once
the current named verifier releases the dedicated reader. This narrow exception
permits the media-only queue for recorded movie files, including unconfirmed
and already published files. Keep media verification required. It grants no
rights clearance, final approval, publication, upload, listener restart, other
hosted migration, or reactivation of contained operator batches.

On 2026-11-04, the owner separately authorized the compatible local web changes
and applying only `20261104201951_multipart_movie_versions.sql` to hosted after
backup and validation. The owner clarified that the web target is the local app
only. That migration was applied after an encrypted backup, a private restore
rehearsal against the actual hosted schema, and disposable database tests. This
exception grants no rights clearance, title approval or publication, Telegram
upload or transfer, remote web deployment, listener restart, other hosted
migration, or reactivation of contained operator batches. Keep the pause marker
and quarantined guards in place.
On 2026-11-05, after the automatic approval review required the exact migration
name, the owner explicitly authorized applying only
`20261104205725_lettered_movie_parts.sql` to hosted after backup and validation.
This extends part recognition to letter aliases for existing files and future
uploads. The web target remains the local app only. This exception grants no
rights clearance, title approval or publication, Telegram upload or transfer,
remote deployment, listener restart, other hosted migration, or reactivation of
contained batches. Preserve the standing-approval pause and quarantined guards.

## Owner-authorized Bloodlines workflow (2026-11-10)

The owner confirmed distribution/streaming rights for **Wrong Turn 5: Bloodlines
(2012), VJ Ice P**, explicitly authorized its upload, and instructed that this
rule allow the prepared one-title workflow. This exception overrides the media
transfer, rights-recording, approval and publication restrictions above **only
for the following verified original**:

* Source post: Velora_Series post 9 (exact link in the ignored `.velora-ingest` owner record) (preserve unchanged).
* Film: TMDB `125509`; VJ `1` (VJ Ice P).
* Source fingerprint: `sf1-078b7fda598f6f5fecfbfe5084b489a43724cf39aa4d83070aa4ddbbd2f55fa6`.
* Full-file SHA-256: `03e805a988b62fcad077060ae763bfe796bfb249027d3c9fd58356f1c61778b7`.
* File size: `1,519,441,250` bytes.

The existing guarded one-file movie workflow may upload this original to the
configured Movies channel and record its ingestion, metadata evaluation,
owner-confirmed title-specific rights decision, fenced media evidence, and
revision-bound approval/publication after every normal gate passes. No further
permission is required for these named steps within this exact scope.

Keep `.velora-ingest/standing-approval.pause` in place. Its presence continues to
contain the standing publisher and batches; it does **not** prohibit this
explicitly authorized one-file workflow. Do not remove or weaken quarantined
entry-point guards, identity checks, source bindings, leases, duplicate or
replacement checks, full-file verification, rights checks, or revision validation.

This exception permits no other title, batch, standing approval, automatic rights
clearance, hosted migration, deployment, push, or discovery-listener restart.


On 2026-11-11, the owner explicitly authorized applying only
`20261111193305_discovery_uploader_visibility.sql` after backup and validation.
It was applied after an encrypted snapshot-consistent backup and a successful
restore rehearsal against the actual hosted schema. This exception adds only
reviewer-guarded, read-only visibility of uploader-owned movies on the local
Discovery page. It grants no rights clearance, approval, publication, media
transfer, listener restart, remote deployment, other hosted migration, or
reactivation of contained batches. Preserve the standing-approval pause and
all existing identity, verification and publication gates.


## Owner-authorized named pending titles (2026-11-11)

The owner explicitly confirmed distribution/streaming rights and authorized
individual guarded rights-recording, final approval and publication for exactly
these existing Movies-channel media files after their normal gates pass:

* 28 Years Later: The Bone Temple - media 148, TMDB 1272837, VJ Ice P, SHA-256 `372e1dc6abc71f28f9f29300b4555425dbecd1e1832904e90b7ea4a258b27088`.
* A Nightmare on Elm Street Part 2: Freddy's Revenge - media 160, TMDB 10014, VJ Jingo, SHA-256 `4614ee267fe115bc7017eed9e305e69f7cafd5c244c7cdf882177d72bf3e96f0`.
* Knightfall - media 149, TMDB 1377900, VJ Ice P, SHA-256 `ec168b58abfcaf021f7cc228e5c88a92e6c0e11f6ba336fe8269d81f2d874cf7`.
* Redbad - media 157, TMDB 485296, VJ Ice P, SHA-256 `971544a4bd93eef46fddde0b26ecb85296e56c39dbb48ac2eefe4fb540efb5ff`.
* Runner - media 150, TMDB 1377237, VJ Ice P, SHA-256 `0671951cf8bb8afd335343b22032aa9bc970f035db0dfda61271e44c2fa7e238`.
* The Forever Purge - media 153, TMDB 602223, VJ Ice P, SHA-256 `93f44d3ab17dc8d8fdabadc9dc1a11bfbb4136a74aa61519da7bbf5bc511b5fb`.
* The Gentleman - media 152, TMDB 1426968, VJ Ice P, SHA-256 `f33d7235987d4dcf78669769d80ab91dc78813dfdb0b8bf9a00e81a951e75ca1`.
* The Purge - media 154, TMDB 158015, VJ Ice P, SHA-256 `3f44d184378e225d5e8ff951750182ebe3b066cab97f0c9fa53909acf63f59f1`.
* The Purge: Anarchy - media 155, TMDB 238636, VJ Ice P, SHA-256 `4ddde4a36b8bf8d1d625251279ad746580fbc98e055077a257cf8cd6d2298ce7`.
* The Purge: Election Year - media 156, TMDB 316727, VJ Ice P, SHA-256 `1e0a4a7b4d65dee16911de9ae97f082ea5bb3bac3603399dec61e29d42944e9e`.

The exact source keys and review revisions are recorded in
`.velora-ingest/pending-uploads-20261111/owner-title-authorizations.json`.
This is a finite title-specific authorization, not standing approval or a
reactivation of any contained batch. Keep the pause marker and all quarantined
entry-point guards. Preserve source bindings, identities, leases, duplicate and
replacement checks, full-file verification and revision validation. Stop a title
if any gate fails or its bound source changes. This exception permits no other
title, replacement, upload/transfer, hosted migration, remote deployment, push or
discovery-listener restart.


On 2026-11-12 EAT, in response to the explicit question about the next ten
verified source files, the owner stated "ALL RIGHTS ARE APPROVED". This records
rights confirmation only for media 2, 129, 133, 127, 118, 102, 113, 112, 159 and
109, bound to the exact digests in
`.velora-ingest/pending-uploads-20261111/owner-additional-rights-confirmation.json`.
Their correct film/year identities remain unconfirmed; do not infer identity
from this rights decision or automatically confirm a TMDB match. Use the
recorded rights decision for these same files after identity review and normal
gates pass. This grants no standing/future-title rights, contained-batch
reactivation, media upload/transfer, migration, deployment or listener restart.
Preserve the pause marker and all existing source, lease and review gates.


## Owner-authorized Series-channel Wrong Turn films (2026-11-18)

After a scan of the Velora_Series channel, the owner confirmed the film
identities below, confirmed distribution/streaming rights, and authorized upload
and publication ("all are confirmed and authorised. approved, start
implementation"). As with Bloodlines, this exception overrides the media
transfer, rights-recording, approval and publication restrictions above **only
for these exact source originals**, all credited to VJ Ice P (VJ `1`):

* Post 5 - Wrong Turn (2003), TMDB 9902, file `WRONG TURN 01. VJ ICE P.mp4`, 1,407,969,245 bytes, file unique id `AgAEJgACSjaRUw`.
* Post 6 - Wrong Turn 2: Dead End (2007), TMDB 13186, file `WRONG TURN 02. DEAD END. VJ ICE P.mp4`, 2,025,385,303 bytes, file unique id `AgADASYAAko2kVM`.
* Post 7 - Wrong Turn 3: Left for Dead (2009), TMDB 23823, file `WRONG TURN 03. LEFT FOR DEAD. VJ ICE P .mp4`, 1,410,674,714 bytes, file unique id `AgADAyYAAko2kVM`.
* Post 8 - Wrong Turn 4: Bloody Beginnings (2011), TMDB 71672, file `WRONG TURN 4.BLOODY BEGINNINGS_VJ ICE P.mp4`, 1,530,443,096 bytes, file unique id `AgADBCYAAko2kVM`.
* Post 10 - Wrong Turn 6: Last Resort (2014), TMDB 259072, file `WRONG TURN 6-LAST RESORT.VJ ICE P.mp4`, 1,448,178,567 bytes, file unique id `AgADByYAAko2kVM`.
* Post 11 - Wrong Turn (2021), TMDB 630586, file `WRONG TURN 7.2021. VJ ICE P.mp4`, 1,752,610,727 bytes, file unique id `AgADCSYAAko2kVM`.

Source posts are the Velora_Series posts (exact links in the ignored owner records) and stay unchanged. Each
file's full SHA-256 and source fingerprint are bound at local verification and
recorded in `.velora-ingest/series-wrong-turn-20261118/`; the owner record is
`owner-authorization.json` there. The existing guarded one-file movie workflow
may, per file: download it through the local series bot, fully verify it, upload
that verified original once to the configured Movies channel, record ingestion
and metadata evaluation, and approve/publish it with the owner's title-specific
rights confirmation after every normal gate (including current hosted
whole-file evidence with the same SHA-256) passes. Stop a file if any gate fails
or its bound source changes.

The owner also authorized local download and full-file verification only of
Money Heist S01E01-S01E13 (posts 12-24, TMDB TV 71446). Episodes must not be
labelled as movies; their upload and publication wait for series support.

Keep `.velora-ingest/standing-approval.pause` and the quarantined guards. This
permits no other title, batch, standing approval, hosted migration, deployment,
push or discovery-listener restart.


## Owner-authorized Money Heist Season 1 series support (2026-11-19)

The owner asked for series support for Money Heist, chose to use the existing
Velora_Series posts in place (no re-upload), confirmed distribution/streaming
rights for **Money Heist Season 1, episodes 1-13 (TMDB TV 71446), VJ Ice P**,
and authorized their publication once series support is built and every gate
passes. The files are Velora_Series posts 12-24 (exact links in the ignored owner record) (post
N is episode N-11), each bound to the size, file unique id and full SHA-256
verified locally on 2026-11-19 and recorded in
`.velora-ingest/series-money-heist-20261118/owner-authorization.json`.

This permits local series-support code, local migrations and disposable-database
tests; registering the Series channel and recording these 13 posts as series
media; whole-file verification of them by the dedicated reader once the owner
adds it to Velora_Series with all rights off; and owner-path rights recording,
approval and publication of exactly these 13 episode versions. It does **not**
authorize any hosted migration: each needs the owner's approval of its exact
file name, after backup and validation. No Telegram upload or transfer, other
title or episode, remote deployment, push, listener restart or contained-batch
reactivation. Keep `.velora-ingest/standing-approval.pause` and the quarantined
guards; stop an episode if any gate fails or its bound source changes.
