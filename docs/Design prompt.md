# VELORA — Modern Movie Discovery Platform

You are a senior product designer, UI/UX designer, and frontend design engineer.

Your task is to design and implement the visual experience for **VELORA**, a modern movie and TV discovery platform.

VELORA should feel like a polished global consumer product — cinematic, sophisticated, fast, minimal, and highly usable — rather than a tutorial project or a direct clone of an existing streaming service.

The product is currently a responsive web application but is intentionally being designed so its experience can later translate naturally into an **Expo / React Native mobile application**.

**Source of truth.** `DESIGN.md` ("Cognitive Deep-Blue Glass") defines the visual system: colour, typography, spacing, radii, elevation and component styling. This document defines the *product and UX* — what screens exist, how they are organised and how they behave — and applies that visual system to a movie and TV discovery product. Where the two disagree, `DESIGN.md` wins. `DESIGN.md` also contains copy written for an enterprise-AI product ("AI assistants" chips, dashboards); take its *visual* rules, not that subject matter. Implemented tokens live in `app/globals.css`.

---

# 1. Product Vision

VELORA helps users:

* Discover movies and TV shows
* Browse trending and popular content
* Search quickly
* Explore movie/show details
* Discover cast and related content
* Watch trailers
* Save titles to personal watchlists
* Mark favourites
* Receive recommendations
* Maintain a personal entertainment profile

The experience should prioritize **discovery**.

Users should be able to open VELORA and immediately find something interesting.

The interface should feel:

**Cinematic + Premium + Minimal + Fast + Personal**

Do not make it visually noisy.

Do not overload screens with unnecessary UI.

Content — especially posters, backdrops, titles, and imagery — should remain the visual focus.

---

# 2. Before Designing or Coding

FIRST inspect the existing repository.

Before creating anything:

1. Read `AGENTS.md`.
2. Inspect the current project structure.
3. Identify existing:

   * components
   * layouts
   * navigation
   * typography
   * colors
   * utilities
   * cards
   * buttons
   * loaders
   * search UI
   * movie sections
   * design tokens
4. Reuse existing components wherever practical.
5. Extend or compose existing components before creating new ones.

Follow this priority:

```text
REUSE
  ↓
COMPOSE
  ↓
EXTEND
  ↓
CREATE
```

Do NOT recreate an existing component just to achieve a slightly different visual treatment.

Do NOT create:

```text
MovieCard.tsx
MovieCard2.tsx
ModernMovieCard.tsx
TrendingMovieCard.tsx
PopularMovieCard.tsx
```

when one well-designed reusable component can support the required use cases.

Do not perform unrelated rewrites.

---

# 3. Brand

Product name:

# VELORA

The VELORA brand should feel distinctive enough to become a standalone entertainment technology brand.

Avoid copying Netflix, Disney+, Prime Video, Apple TV+, IMDb, Letterboxd, or TMDB.

They may inform general UX conventions, but VELORA must have its own visual identity.

The logo is a film-strip "V" containing a play symbol, in luminous blues on deep navy, with a widely tracked geometric wordmark. Its palette is the same as the interface, so the mark sits on the canvas without a container.

* Source artwork: `public/images/logo.webp`
* UI lockup (mark + wordmark, transparent background): `public/images/logo-lockup.webp`, rendered by the shared `Logo` component
* The name is written **Velora** in running text and **VELORA** in the wordmark

The wordmark should feel:

* Modern
* Clean
* Premium
* Recognizable
* Simple enough for mobile

Avoid overly decorative branding.

---

# 4. Visual Direction

Design VELORA as a premium cinematic product on the "Cognitive Deep-Blue Glass" system defined in `DESIGN.md`: an ultra-refined dark experience of deep midnight navy and luminous photonic blues, combining crisp minimalism with **controlled glassmorphism**.

Use:

* Strong movie imagery — artwork is always the focal point
* Atmospheric depth: an obsidian-navy canvas with a faint ambient blue glow
* Glass surfaces where they add structure: navigation bars, content panels, overlays
* Razor-thin 1px micro-borders on translucent layers
* Electric illumination: cobalt and sky-blue accents to direct the eye, and to mark hover, focus and active states
* Chromatic glow and soft layered shadows in place of harsh drop shadows
* Calibrated spacing on an 8px rhythm, with generous section spacing
* Clear hierarchy and clean geometric typography
* High-quality poster presentation
* Short, elegant transitions

Avoid:

* Glass around everything — posters stay bare; glass belongs to chrome and content panels
* Stacked heavy blurs
* Neon overload — glow is reserved for hover, focus and active states
* Heavy borders and huge shadows
* Excessive badges — eyebrow pills only for featured content and category tags
* Dashboard-style boxes everywhere
* Visual clutter
* Over-animation
* Generic AI-generated SaaS aesthetics — no "AI" motifs; this is entertainment

This is an entertainment experience, not an analytics dashboard.

---

# 5. Theme

VELORA UG supports **system, light, and dark** appearance preferences. Dark remains the cinematic signature; light uses a warm-neutral canvas while preserving the cobalt-and-sky identity.

Do NOT hard-code colours in components. Both themes use the semantic tokens defined in `app/globals.css` from `DESIGN.md`:

| Token | Value | `DESIGN.md` name | Use |
| --- | --- | --- | --- |
| `background` | `#070B14` | canvas-default | Page canvas |
| `canvas-subtle` | `#0A0F1D` | canvas-subtle | Footer, input fill, artwork placeholders |
| `surface` | `rgba(255,255,255,0.04)` | surface-glass | Glass panels (layer 1) |
| `surface-elevated` | `rgba(255,255,255,0.08)` | surface-glass-hover | Hover and raised glass |
| `border` | `rgba(255,255,255,0.10)` | border-glass | 1px outlines and dividers |
| `foreground` | `#FFFFFF` | text-primary | Headlines, key values |
| `muted` | `#94A3B8` | text-secondary | Body copy, metadata, captions |
| `accent` | `#2563EB` | primary | Primary actions |
| `accent-hover` | `#1D4ED8` | primary-hover | Pressed / hover fill |
| `accent-foreground` | `#FFFFFF` | — | Text on `accent` |
| `highlight` | `#38BDF8` | secondary | Focus, active navigation, eyebrows, hover edges |
| `tertiary` | `#60A5FA` | tertiary | Gradient endpoints, feature highlights |
| `destructive` | `#FFB4AB` | error | Error emphasis |
| `star` | `#F59E0B` | — | Rating stars only |

Rules:

* The palette is one blue family with a clear job for each step. Do not add other hues.
* Use **cobalt (`accent`) for primary actions only** — ideally one per view.
* Use **sky (`highlight`) for state**: focus rings, the active navigation indicator, eyebrow pills, and hover edges (`rgba(56,189,248,0.4)`).
* `star` is the single non-palette colour: a star is read as a rating the world over.
* Where `DESIGN.md`'s YAML front matter and its Colors section differ (e.g. `background` `#0F131D` vs canvas-default `#070B14`), the **Colors section wins**.

Accessibility adjustment: `DESIGN.md`'s `text-muted` (`#64748B`) measures only 4.1:1 on the canvas, below WCAG AA for small text, so captions and inactive labels use `muted` (`#94A3B8`, 7.5:1) instead. White on `accent` is 5.2:1.

---

# 6. Typography

**Plus Jakarta Sans** is the only typeface: contemporary geometric precision with humanist balance. It is loaded as a single variable font (weights 400–800).

Headlines and display text are bold and tight-tracked (negative letter-spacing) for authority and impact; body copy uses neutral slate and generous line height to reduce fatigue in dark mode.

The scale below is defined in `DESIGN.md` and available as theme utilities (`text-display-hero`, `text-headline-sm`, …):

| Role | Token | Size / line | Weight |
| --- | --- | --- | --- |
| Hero title | `display-hero` (mobile: `display-hero-mobile`) | 56/64 (36/44) | 800 |
| Page title | `headline-lg` (mobile: `headline-md`) | 40/48 (28/36) | 700 |
| Section title | `headline-sm` | 20/28 | 600 |
| Movie title | `body-md` | 15/24 | 600 |
| Body copy | `body-md`; `body-lg` for hero and detail overview from 768px | 15/24; 18/28 | 400 |
| Metadata | `body-sm` | 13/20 | 400 |
| Buttons, navigation, tabs | `label-lg` | 14/20 | 600 |
| Supporting labels | `label-md` | 12/16 | 600, +0.05em |
| Eyebrows and category chips | `label-tag`, uppercase | 11/14 | 700, +0.08em |

Prioritize:

* Readability
* Strong movie titles
* Clear section headings
* Compact metadata
* Excellent mobile readability

Key narrative phrases in hero copy may shift from white to the sky-to-cobalt gradient (`#38BDF8` → `#2563EB`); use it sparingly.

Do not introduce a second font family. Typography should remain lightweight and performant.

---

# 7. Mobile-First Requirement

Design MOBILE FIRST.

The application must feel intentionally designed for phones rather than like a desktop website compressed onto a smaller screen.

Start design decisions around approximately:

```text
320px
360px
375px
390px
430px
```

Then progressively enhance for:

```text
tablet
laptop
desktop
large desktop
```

No horizontal overflow should occur accidentally.

Touch targets must be comfortable.

Important actions must never depend on hover.

---

# 8. Responsive Philosophy

Do not simply shrink desktop components.

Components should adapt.

For example:

Desktop navigation may use:

```text
VELORA    Home    Movies    TV Shows    Discover           Search    Profile
```

while mobile can use a compact top bar plus bottom navigation:

```text
┌───────────────────────────┐
│ VELORA               🔍   │
│                           │
│        Content            │
│                           │
├───────────────────────────┤
│  Home  Discover  Saved  Me│
└───────────────────────────┘
```

Treat these as conceptual directions, not rigid layouts.

Choose the best information architecture based on the existing application.

---

# 9. Homepage

The homepage should immediately communicate that VELORA is a movie discovery platform.

Consider this hierarchy:

```text
Navigation
     ↓
Cinematic Hero
     ↓
Trending
     ↓
Popular Movies
     ↓
Popular TV
     ↓
Top Rated
     ↓
Genre/Discovery sections
     ↓
Additional personalized sections later
```

Do not display every possible section simply because data exists.

Prioritize useful discovery.

---

# 10. Hero

The hero is the emotional anchor of the homepage.

Use a high-quality cinematic backdrop.

The hero may include:

* Movie/show title
* Short overview
* Release year
* Rating
* Genre
* Primary CTA
* Secondary action

Example conceptual hierarchy:

```text
                     cinematic backdrop

[• FEATURED]   <- eyebrow pill: sky text, cobalt tint, sky border

Dune: Part Two

2024   ★ 8.3   Sci-Fi · Adventure

Paul Atreides unites with Chani and the Fremen
while seeking revenge against those who destroyed
his family.

[ View Details ]    [+ Watchlist]
```

Do not overload the hero with metadata.

Use gradients carefully to maintain text readability over artwork.

The hero title uses `display-hero`; the primary CTA is solid cobalt and the secondary action is a glass button (see `DESIGN.md` → Buttons). Carousel controls are glass with a sky active state.

The hero should scale gracefully on mobile.

On mobile:

* Keep text concise
* Keep CTAs touch-friendly
* Prevent the hero from consuming an unreasonable amount of vertical space
* Preserve important focal areas of the backdrop

---

# 11. Movie Cards

Movie posters are among the most important reusable visual components.

Design one flexible `MovieCard` system rather than separate cards for every section.

A card may support:

* Poster
* Title
* Release year
* Rating
* Optional status/action

Keep metadata restrained.

Do not place large containers around posters unnecessarily.

Poster artwork should remain dominant.

Posters use the large radius (16px) and a 1px glass border. On hover the poster lifts slightly and gains a sky edge with a soft cobalt glow; the same title, year and rating are always visible without hover. Titles without artwork fall back to a blue gradient carrying the title — never a different card.

Maintain correct movie poster aspect ratios.

Cards should support:

```text
Mobile
2 columns where appropriate

Tablet
3–4 columns

Desktop
5–6+ columns depending on available width
```

For horizontally scrollable discovery rows, ensure touch scrolling feels natural.

Desktop hover behavior may reveal additional information, but the same information/action must remain accessible without hover.

---

# 12. Section Design

Sections such as:

```text
Trending Now
Popular Movies
Popular TV Shows
Top Rated
Because You Watched...
```

should use a consistent reusable section structure.

Example:

```text
Trending Now                              View all →

[poster] [poster] [poster] [poster] [poster] [poster]
```

Section headings should be easy to scan without competing with movie artwork.

---

# 13. Search Experience

Search is a primary product feature.

It should feel exceptionally fast.

Support:

* Search icon/action
* Clear search input
* Debounced results
* Loading state
* Empty state
* Error state
* Recent searches later
* Trending searches later

On mobile, consider a dedicated search experience rather than squeezing a large input into the navigation.

Example:

```text
Search VELORA
┌─────────────────────────────┐
│ 🔍 Search movies & shows... │
└─────────────────────────────┘

Trending searches

Dune
The Last of Us
Oppenheimer
Interstellar
```

Do not make search visually complicated.

---

# 14. Movie Detail Page

The movie detail page should feel cinematic and editorial.

Consider:

```text
Backdrop
    ↓
Poster + Core information
    ↓
Title
Metadata
Genres
Rating
Overview
Actions
    ↓
Trailer
    ↓
Cast
    ↓
Related / Similar Movies
```

Desktop can use poster + content side-by-side.

Mobile should reorganize naturally into a vertical layout.

Primary actions may include:

```text
Watch Trailer
Add to Watchlist
Favourite
```

Avoid excessive metadata above the fold.

Prioritize information users actually use when deciding whether a movie interests them.

---

# 15. Cast

Cast should be visual but lightweight.

Use reusable person cards.

Show only useful information initially:

```text
Photo
Actor name
Character
```

Do not make cast cards compete visually with movie cards.

---

# 16. Watchlist

The watchlist should feel personal and clean.

Support:

* Saved movies/shows
* Easy removal
* Empty state
* Potential filtering later

Empty states should feel intentional.

Example concept:

```text
Your watchlist is empty.

Save movies and shows you want to discover later.

[ Explore Movies ]
```

---

# 17. Navigation

Navigation should remain simple.

Avoid too many top-level destinations.

Potential structure:

```text
Home
Movies
TV Shows
Discover
Watchlist
```

Search should remain prominent.

The top bar (desktop) and bottom tab bar (mobile) are the product's glass chrome: translucent canvas with backdrop blur and a 1px glass border. The active destination is marked by a sky indicator as well as a brighter label, never colour alone.

User/profile functionality should be accessible without dominating navigation.

On mobile, prioritize the destinations users need most frequently.

---

# 18. Loading States

Use skeletons that approximate actual content geometry.

For example:

```text
████████
████████
████████
████████
████████
████████
────────
██████
```

for a poster card.

Reuse existing skeleton components.

Avoid loading spinners everywhere.

Skeletons should not cause large layout shifts when real content arrives.

---

# 19. Empty States

Design intentional empty states for:

* Search with no results
* Empty watchlist
* Empty favourites
* Missing recommendations
* Failed content loading where appropriate

Keep copy concise and useful.

---

# 20. Error States

Errors should be understandable and recoverable.

Where appropriate provide:

```text
Something went wrong.

[ Try Again ]
```

Do not expose technical errors to end users.

---

# 21. Performance

VELORA must remain lightweight.

Visual sophistication must NOT come at the cost of excessive JavaScript.

Prefer:

```text
CSS
Tailwind
native browser behavior
Server Components
```

over heavy frontend libraries.

Do not add an animation library unless existing CSS/Tailwind capabilities genuinely cannot satisfy the requirement.

Do not install large packages merely for visual polish.

Before adding ANY dependency, verify that:

1. The functionality does not already exist.
2. Existing dependencies cannot solve it.
3. CSS/browser APIs cannot reasonably solve it.
4. The dependency provides enough value to justify its weight.

---

# 22. Images and Performance

VELORA is image-heavy.

Treat image performance as a core design requirement.

Use appropriately sized TMDB images.

Do not request full-resolution images for small cards.

Use:

* Responsive image sizing
* Correct aspect ratios
* Lazy loading
* Appropriate priority for above-the-fold imagery
* Graceful image fallbacks
* Layout-stable containers

Avoid unnecessary image downloads.

---

# 23. Motion

Motion should feel polished but almost invisible.

Good uses:

* Card transitions
* Button feedback
* Menu transitions
* Sheet/dialog transitions
* Image loading
* Navigation feedback

Prefer short CSS transitions.

Avoid:

* Large page animations
* Constant moving backgrounds
* Excessive parallax
* Animation on every element

Respect reduced-motion preferences.

---

# 24. Accessibility

The visual design must not sacrifice accessibility.

Ensure:

* Strong contrast
* Visible focus states
* Keyboard navigation
* Semantic HTML
* Proper labels
* Appropriate alt text
* Accessible dialogs
* Accessible navigation
* Touch-friendly controls

Never rely solely on color to communicate state.

---

# 25. Design System

The design system is `DESIGN.md`. Keep it small and coherent, and simple enough for a future React Native implementation.

### Color

Semantic tokens from section 5. Layers: canvas (`background`) → glass (`surface`) → raised glass (`surface-elevated`).

### Typography

Plus Jakarta Sans and the scale in section 6.

### Spacing

An 8px base rhythm.

| Token | Value | Use |
| --- | --- | --- |
| `space-xs` … `space-xl` | 4, 8, 16, 24, 40px | Component internals |
| `space-2xl` | 64px | Between major sections (desktop; 48px on phones) |
| Page margin | 20px phones, 40px from 768px | Outer gutter |
| Grid gutter | 16px phones, 24px above | Between cards |
| Max content width | 1280px | Centred container |

Breakpoints follow `DESIGN.md`: mobile below 768px (4-column flow), tablet 768–1199px, desktop 1200px and up (12-column).

### Radius

| Token | Value | Use |
| --- | --- | --- |
| `default` | 8px | Buttons, inputs, list thumbnails, popovers |
| `md` | 12px | Small panels |
| `lg` | 16px | Posters, glass panels, trailer, modals |
| `full` | pill | Category chips, status pills, avatars |

Do not make every element rounded: controls stay at 8px.

### Elevation

Depth comes from translucent layers and chromatic glow, not heavy drop shadows.

* **Layer 0 — canvas:** matte `#070B14`, with an optional faint radial glow such as `radial-gradient(ellipse at 80% 40%, rgba(37,99,235,0.12), transparent 60%)`.
* **Layer 1 — glass:** `rgba(255,255,255,0.04)`, 16px blur, 1px border `rgba(255,255,255,0.08–0.10)`.
* **Layer 2 — floating:** raised surfaces with `0 12px 32px -4px rgba(0,0,0,0.6), 0 0 24px rgba(37,99,235,0.15)`.

### Interaction states

| State | Buttons and controls |
| --- | --- |
| default | Primary: solid cobalt, white text. Secondary: glass fill, 1px glass border |
| hover | Primary: `#1D4ED8` plus a `0 0 20px rgba(37,99,235,0.4)` halo. Secondary: border `rgba(56,189,248,0.4)`, fill `rgba(255,255,255,0.08)` |
| focus | Sky (`#38BDF8`) ring; inputs take a sky border with `0 0 0 3px rgba(56,189,248,0.2)` |
| active | Pressed fill (`#1D4ED8` or raised glass) |
| disabled | 50% opacity, no pointer events |
| loading | Skeletons that match final geometry; a text change (e.g. "Retrying…") for buttons |

Inputs: `canvas-subtle` fill at 80%, 1px glass border, white text, placeholder in a lightened `muted`.

---

# 26. Component Reuse

Before creating a component, search the project.

Preferred reusable primitives include concepts such as:

```text
MovieCard
PersonCard
MediaGrid
MediaRow
SectionHeader
Rating
GenreBadge
SearchInput
EmptyState
PosterImage
BackdropImage
```

These are conceptual examples.

Do NOT create them automatically if equivalent components already exist.

Do NOT abstract trivial markup merely to satisfy this list.

Reuse first.

---

# 27. shadcn/ui

Use existing shadcn/ui components where they provide useful accessible primitives.

Potential examples:

* Dialog
* Sheet
* Dropdown Menu
* Tooltip
* Tabs
* Button
* Input
* Skeleton

Do not turn VELORA into a generic shadcn dashboard.

shadcn should provide underlying primitives.

VELORA's visual identity should come from our design system and content.

---

# 28. Client JavaScript

Keep client-side JavaScript minimal.

Do not turn entire pages into Client Components merely for one interaction.

Prefer:

```text
Server-rendered page
       │
       ├── static/server content
       ├── movie grids
       └── small interactive islands
```

Keep `"use client"` boundaries narrow.

---

# 29. Mobile App Future

Remember that VELORA is expected to eventually have:

```text
Expo + React Native
```

Do not design interactions that only make sense with a mouse.

Concepts should translate naturally to:

* Touch
* Native navigation
* Bottom tabs
* Mobile sheets
* Native gestures

Web and mobile do NOT need to share identical UI code.

They should share the same product language and design system concepts.

---

# 30. Avoid Generic Design

Do not produce a generic movie tutorial interface.

Avoid the predictable combination of:

```text
black background
red buttons
Netflix-like navigation
identical horizontal carousels everywhere
```

VELORA needs its own identity.

That identity is the deep-blue glass system in `DESIGN.md`: obsidian-navy canvas, cobalt and sky illumination, translucent layers, and Plus Jakarta Sans — applied to movie artwork rather than to product dashboards.

Use thoughtful:

* Typography
* Spacing
* Composition
* Artwork presentation
* Navigation
* Accent treatment

to create differentiation without introducing visual complexity.

---

# 31. Design Quality Test

For every screen ask:

### Hierarchy

What should the user notice first?

### Purpose

What is the primary action?

### Clutter

Can anything be removed?

### Reuse

Does an existing component already solve this?

### Mobile

Does this feel intentionally designed at 375px?

### Touch

Can every interaction work without hover?

### Performance

Is visual polish adding unnecessary JavaScript or image weight?

### Accessibility

Can keyboard and assistive-technology users operate it?

### Consistency

Does this feel like the same VELORA product?

---

# 32. Implementation Process

Do NOT redesign the entire application blindly.

Follow this process:

### Step 1 — Audit

Inspect the existing application and identify:

* Existing design
* Existing components
* Duplicate patterns
* Responsive problems
* Accessibility issues
* Visual inconsistencies
* Opportunities for reuse

### Step 2 — Establish Design Direction

Define the VELORA visual language:

* Colors
* Typography
* Spacing
* Radius
* Surfaces
* Navigation behavior
* Card behavior
* Responsive principles

Do not create a massive design system.

### Step 3 — Homepage

Implement/refine:

* Navigation
* Hero
* Core discovery sections
* Movie cards
* Responsive behavior

Reuse existing functionality.

### Step 4 — Search

Create/refine the responsive search experience.

### Step 5 — Detail Page

Create/refine the cinematic movie/show detail experience.

### Step 6 — Personal Features

Apply the same design language to:

* Watchlist
* Favourites
* Authentication/profile

only when those features exist or are requested.

---

# 33. Critical Constraints

DO NOT:

* Rewrite working components unnecessarily.
* Duplicate existing components.
* Install unnecessary packages.
* Introduce heavy animation libraries.
* Introduce a second UI framework.
* Convert entire pages to Client Components unnecessarily.
* Sacrifice performance for visual effects.
* Hard-code the same design values repeatedly.
* Break existing application functionality.
* Change backend/business logic merely for visual redesign unless required.
* Over-engineer the design system.
* Copy another entertainment platform.

DO:

* Inspect first.
* Reuse first.
* Make small coherent changes.
* Keep the app lightweight.
* Design mobile-first.
* Maintain accessibility.
* Optimize imagery.
* Preserve type safety.
* Preserve existing functionality.
* Keep the design consistent.

---

# 34. Desired Result

The final VELORA experience should feel like a product that could credibly ship globally.

When someone opens VELORA, the impression should be:

> "This feels like a real entertainment product."

Not:

> "This looks like a movie API coding project."

The experience should be visually premium without being heavy.

The strongest elements should be:

**movie artwork + typography + spacing + hierarchy + interaction quality**

rather than excessive effects.

Build a distinctive, responsive, cinematic experience while keeping the implementation simple, reusable, performant, and ready for VELORA's eventual transition into a native mobile application.
