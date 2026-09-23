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
