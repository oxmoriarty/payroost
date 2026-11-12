# PayRoost — Current UX, UI & Brand System

## 1. Visual Identity & Color Tokens

PayRoost uses a calm editorial fintech aesthetic defined via `@theme inline` tokens in [`src/app/globals.css`](../../src/app/globals.css):

- **Page Ground:** Warm stone off-white `#f6f5f0`
- **Ink Palette:**
  - `--color-ink-950`: `#07131a`
  - `--color-ink-900`: `#0d1c25`
  - `--color-ink-800`: `#18313d`
  - `--color-ink-700`: `#3b5360`
  - `--color-ink-300`: `#b9c6c9`
  - `--color-ink-200`: `#dbe3e3`
  - `--color-ink-100`: `#edf1f0`
  - `--color-ink-50`: `#f6f8f7`
- **Teal Brand Accents:**
  - `--color-teal-50`: `#e8f7f4`
  - `--color-teal-600`: `#057f79`
  - `--color-teal-700`: `#056760`

Semantic status colors (emerald, amber, rose) are strictly limited to verified workflow badges, alert states, and ledger tags.

---

## 2. Typography

All typefaces are **self-hosted** in [`src/app/layout.tsx`](../../src/app/layout.tsx) without external Google Fonts network requests:
- **Display Headings (`--font-display`):** `@fontsource-variable/plus-jakarta-sans` (`Plus Jakarta Sans Variable`)
- **UI & Body (`--font-sans`):** `@fontsource-variable/manrope` (`Manrope Variable`)

---

## 3. Brand Marks & Landing Visual Assets

- **Brand Vector Suite (`public/brand/` & `src/components/brand.tsx`):**
  - `public/brand/PayRoostLogo.svg` (light surface wordmark)
  - `public/brand/PayRoostLogo-dark.svg` (dark surface wordmark)
  - `public/brand/PayRoostFavicon.svg` and `src/app/icon.svg` (application icon)
- **Editorial Landing Page (`/`):**
  - Built in `src/app/page.tsx` with `src/components/landing/workflow-showcase.tsx`.
  - Features crisp natural copy (no em-dash/hyphen clutter in editorial sentences) and curated raster artwork under `public/images/landing/`:
    - `studio-desk.jpg`
    - `team-planning.jpg`
    - `milestone-3d.jpg`
    - `payment-record.jpg`

---

## 4. Custom Primitives, Motion & Mobile Responsiveness

- **Custom UI Primitives (`src/components/ui/`):** Lightweight accessible `badge.tsx`, `button.tsx`, `card.tsx`, and `motion.tsx` primitives paired with `lucide-react` icons (no Radix UI dependency).
- **Subtle Micro-Interactions:**
  - Scroll/mount reveals (`Reveal` component in `src/components/ui/motion.tsx`), page transitions (`.pr-page-enter`), subtle ambient hero lighting (`.pr-hero-beam`), live status pulse (`.pr-live-dot`), and tactile card hover elevation (`.pr-interactive-card`), all respecting `prefers-reduced-motion: reduce`.
- **Responsive Shell & Payment Grid:**
  - App shell (`src/components/app/sidebar.tsx`, `src/components/app/header.tsx`) provides responsive desktop navigation and mobile drawer/header controls across `/app/*`, `/review/[token]`, and `/portal/[token]`.
  - `/app/payments` uses `ag-grid-react` Community (`AllCommunityModule`, `ag-theme-quartz`) on desktop viewports and switches gracefully to stacked cards below `767px`.
