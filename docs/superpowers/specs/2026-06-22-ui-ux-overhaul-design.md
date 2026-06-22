# UI/UX Overhaul — asguard-ext sidepanel

- **Date:** 2026-06-22
- **Approach:** A — Foundation-first (bottom-up)
- **Status:** Design approved; pending spec review → implementation plan
- **Audited against:** `ui-ux-pro-max` v2.5.0 (10 priority categories)

> Note on location: the conventional `docs/superpowers/specs/` dir is currently
> owned by `root` and not writable by the user, so this spec lives one level up
> in `docs/superpowers/`. Run
> `sudo chown -R $USER:staff docs/superpowers/specs` to reclaim it, then move
> this file into it.

## Goal

Raise the sidepanel's perceived quality, accessibility, and usability without
disrupting the existing strong token-based foundation. The codebase already has
a semantic CSS-variable system, full light/dark palettes, a 4/8dp spacing scale,
skeleton loaders, and tasteful motion — the work builds on that rather than
replacing it.

## Current-state findings (evidence)

Findings from `styles.css`, `App.tsx`, `SimanHomeView.tsx`, `SummaryView.tsx`.
Severity uses the ui-ux-pro-max priority tiers.

| # | Finding | Severity | Evidence |
|---|---------|----------|----------|
| 1 | No visible focus states | CRITICAL | no `:focus-visible` anywhere in `styles.css`; only `.input`/`.textarea` get a border tint |
| 2 | Emoji as structural icons | CRITICAL | `📄🏛✨📋📜📈📡📦⚙️🔄👤` across `App.tsx`, `SimanHomeView.tsx`, `SummaryView.tsx` |
| 3 | No `prefers-reduced-motion` guard | CRITICAL | animations everywhere; `.streaming__cursor` blinks infinitely (`styles.css:544`) |
| 4 | Borderline contrast on secondary text | HIGH | `--muted:#6b7c73` ≈ 4.4:1 on white, used at 11–12px |
| 5 | Color-only status indicators | HIGH | `.dot--ok/--warn` carry state by hue alone |
| 6 | Undersized click targets | HIGH | `.btn--xs` ≈20px, `.mm-change-file` ≈18px, tab rows |
| 7 | SIMAN nav deep, no wayfinding | HIGH | 4–6 level stack, only `‹` + title (`App.tsx:194-261`) |
| 8 | Theming inconsistency between tabs | HIGH | `--accent` = green globally (`styles.css:31`); SIMAN controls go green despite blue theme |
| 9 | No systematized type scale | MEDIUM | ad-hoc 10/10.5/11/11.5/12/12.5/13/13.5/14/15/17px |
| 10 | Heavy inline `style=""` in components | MEDIUM | `SimanHomeView.tsx`, `App.tsx` (LicenseCard, NadineUserCard, monitoring menu) |
| 11 | Inter declared but not shipped | MEDIUM | `index.html` loads no fonts; `--font:"Inter"` falls back to system-ui |
| 12 | Streaming/async errors lack `aria-live` | MEDIUM | `.run-progress__error`, chat `❌` bubble are plain text |

## Approach rationale

Approach A (foundation-first) is chosen over B (surface-by-surface) and C
(priority-tier) because the codebase is already token-driven. Hardening the
token layer first means Phase 1 — a single CSS diff with no view-logic risk —
resolves six of the twelve findings across the entire app at once, and every
subsequent phase is independently shippable.

## Phase 1 — Token foundation (CSS-only)

**Scope:** `src/sidepanel/styles.css` + `src/sidepanel/index.html`. No component
logic changes.

**Resolves:** #1, #3, #4, #8, #9, #11.

### 1.1 Focus primitive (#1)

Add a global keyboard focus ring:

```css
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}
:focus:not(:focus-visible) { outline: none; }
```

Inputs keep their existing `:focus` border-color tint as a secondary cue; the
outline is additive for keyboard users only. Remove the bare `outline: none`
on `:focus` found in `.mm-search`, `.ph-config__input`, `.arsip-search-input`
(rely on `:focus-visible` instead so keyboard users still get a ring).

### 1.2 Reduced-motion guard (#3)

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
  .streaming__cursor { animation: none; opacity: 1; }
}
```

Neutralizes `fade-in`, `skeleton-pulse`, `cursor-blink`, `modal-up`,
`arsip-spin`, and all transitions.

### 1.3 Per-tab accent (#8)

Add a tab-scoped class on the panel root (`App.tsx`):

```tsx
<div class={`panel panel--${activeTab}`}>  // panel--nadine | panel--siman
```

```css
.panel--nadine { --accent: var(--color-primary); }   /* default, green */
.panel--siman  { --accent: var(--siman-accent); }    /* blue */
```

Because `--accent` cascades, every `var(--accent)` control inside the SIMAN tab
flips from green to blue in one override. Follow-up grep: any SIMAN view using
`var(--color-primary)` directly should switch to `var(--accent)` so it follows
the tab. Nadine-only primitives may keep `--color-primary`.

### 1.4 Contrast fix (#4)

Light mode `--muted`: `#6b7c73` (≈4.4:1) → `#5b6b62` (≈5.0:1). Verify dark-mode
`--muted:#7a9484` on `--surface:#1c2420` already meets ≥4.5:1 (expected to pass;
re-measure after change).

### 1.5 Type-scale tokens (#9)

Introduce and apply to core primitives:

```css
--text-xs: 11px;   /* floor — nothing smaller */
--text-sm: 12px;
--text-base: 13px;
--text-md: 14px;
--text-lg: 15px;
--text-xl: 17px;
```

Apply in Phase 1 to: `body`, `.btn`, `.hint`, `.row__label`, `.row__value`,
`.card__title`, `.panel__title`. Raise the floor: replace any 10 / 10.5px
occurrence with `--text-xs` (11px). The long tail (one-off sizes in mail-merge /
arsip views) migrates during Phase 5.

### 1.6 Inter preload (#11)

In `index.html` `<head>`, add preconnect + a single Inter request
(400/500/600/700):

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet"
  href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" />
```

Keep the system-ui fallback in `--font` so offline/first-paint still renders.

### Phase 1 verification

`npm run typecheck`; load unpacked; confirm: keyboard Tab through home + a SIMAN
screen shows visible rings; toggle OS reduced-motion and confirm no animation;
confirm SIMAN controls are blue, Nadine green; confirm `--muted` text reads
cleanly at 11–12px; confirm Inter renders.

---

## Phase 2 — Icon system

**Scope:** new `src/sidepanel/components/Icon.tsx`; view-by-view migration.

**Resolves:** #2.

### 2.1 Component

Dependency-free inline SVG. Lucide path data (MIT, compatible license). Icons
inherit `currentColor` so they theme automatically via the per-tab `--accent`
from Phase 1.3.

```tsx
type IconName = "file-text" | "landmark" | "sparkles" | /* … */ ;
const PATHS: Record<IconName, string> = { /* Lucide <path> innerHTML per name */ };

export function Icon({ name, size = 18, class: cls }: {
  name: IconName; size?: number; class?: string;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round"
      stroke-linejoin="round" class={cls}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: PATHS[name] }} />
  );
}
```

- `aria-hidden="true"` because icons are decorative — meaning is in adjacent text.
- No `lucide-preact` / Iconify dependency (lean bundle, full theming control).
- Path data sourced from Lucide at implementation time (do not hand-author).

### 2.2 Emoji → icon map

| Emoji | Icon name | Used in |
|-------|-----------|---------|
| 📄 | `file-text` | Nadine tab |
| 🏛 | `landmark` | SIMAN tab |
| ✨ | `sparkles` | Ringkas AI, summary idle |
| 📋 | `clipboard-list` | Template |
| 📜 | `scroll` | Daftar Pengelolaan |
| 📈 | `trending-up` | Evaluasi Kinerja |
| 📡 | `satellite` | Monitoring |
| 📦 | `package` | Arsiparis |
| ⚙️ | `settings` | Settings |
| 🔄 | `refresh-cw` | Ringkas ulang, reload, update |
| 👤 | `user` | User card |
| ⚠️ | `alert-triangle` | Warnings |
| ✅ | `check-circle` | Success / done |
| ⏳ | `loader` | Summarizing / busy |
| ↑ | `arrow-up` | Chat send |
| › | `chevron-right` | Action card arrow |
| ‹ | `chevron-left` | Back |

Status dots (#5) get their own icons in Phase 3.

### 2.3 Migration order

Hotspots first: `App.tsx` (tab bar, home action cards, monitoring menu, license
card), then `SimanHomeView.tsx`, then `SummaryView.tsx`, then the remaining
views. Each view is a self-contained commit.

### Phase 2 verification

`npm run typecheck`; confirm no emoji remain as structural icons; confirm icons
inherit tab accent (green in Nadine, blue in SIMAN); confirm crisp at 16/20px.

---

## Phase 3 — A11y interactions

**Scope:** `styles.css`, `components`, view tweaks.

**Resolves:** #5, #6, #12.

### 3.1 Color + label on status (#5)

Every `.dot--*` must have an adjacent icon or text label, never hue alone.

- License status rows already carry text — verify each.
- EWS 5-state palette (`--ews-lewat/kritis/perhatian/aman/confirmed`) pairs each
  color with a distinct icon (`clock`, `alert-octagon`, `alert-triangle`,
  `shield-check`, `check`) plus its text label.

### 3.2 Target sizing (#6)

Introduce `--target-min: 32px;` and apply: `.btn--xs`, `.mm-change-file`,
`.ph-config__type-select`, `.tab-bar__tab` rows, and any control currently under
32px. Express as `min-height` so padding can stay compact.

### 3.3 `aria-live` on async/error regions (#12)

- `.run-progress__error`, summary error `<section class="card card--error">`,
  chat error bubble → `role="alert"`.
- Streaming summary container: `aria-busy="true"` while streaming, `false` on
  done. Do **not** put the per-chunk text in an `aria-live` region (screen-reader
  spam); the final result is reached by normal focus.

### Phase 3 verification

`npm run typecheck`; grayscale the panel and confirm status is still legible
(icon + text); confirm no clickable control under 32px; trigger a stream error
and confirm a screen reader announces it.

---

## Phase 4 — SIMAN (+ Nadine) wayfinding

**Scope:** new `Breadcrumb` component; `App.tsx` headers.

**Resolves:** #7.

### 4.1 Breadcrumb

A `Breadcrumb` component derives the trail from the active view kind and renders
each ancestor as a clickable segment (jump-back), with the current leaf as
plain text. `‹` remains as quick-back.

SIMAN trails (from `simanView.kind`):

| kind | Trail |
|------|-------|
| `template-list` | Template |
| `template-detail` | Template › Detail |
| `daftar` | Daftar Pengelolaan |
| `run` | Daftar › Buat Naskah |
| `evaluasi` | Evaluasi |
| `evaluasi-detail` | Evaluasi › Detail |
| `monitoring` | Monitoring |
| `monitoring-scrape` | Monitoring › Scrape |
| `monitoring-ews` | Monitoring › EWS |
| `monitoring-ews-detail` | Monitoring › EWS › Detail |

Nadine template sub-stack gets the same treatment (Template › Detail / Mail
Merge / Input Manual) for consistency. Home views show no breadcrumb.

Clicking an ancestor segment calls the same setter that back uses, jumped to
that level. Each segment is a real `<button>` (keyboard-focusable from Phase 1).

### 4.2 Layout note

This is the one genuinely visual choice. Before committing to a final layout
(top-of-header inline vs. second row), optionally mock it in a browser. Default:
inline within the existing `BackHeader` row, segments separated by a muted
`chevron-right`.

### Phase 4 verification

`npm run typecheck`; navigate to `monitoring-ews-detail` and confirm the trail
shows and each ancestor jumps back correctly; keyboard-navigate the segments.

---

## Phase 5 — Cleanup

**Scope:** extract repeated inline styles; finish type-token migration.

**Resolves:** #10 (+ #9 long tail).

Extract the highest-repeat inline `style=""` patterns into classes:
- `SimanHomeView.tsx` user card + role strip → `.siman-user-card`,
  `.siman-role-strip`, `.siman-role-row`.
- `App.tsx` monitoring menu buttons → `.menu-btn`.
- `LicenseCard` / `NadineUserCard` rows → shared row classes.
- `SimanEwsView` / `SimanEwsDetailView` repeated patterns.

**YAGNI boundary:** one-off styles stay inline. The goal is consistency and
dark-mode testability, not 100% inline elimination. Finish migrating remaining
hardcoded font-sizes to the Phase 1 type tokens during this pass.

### Phase 5 verification

`npm run typecheck`; visual diff in light + dark; confirm no regression.

---

## Cross-cutting

- **No test runner** exists in this project (`tsc --noEmit` is the only static
  check). Verification is manual: `npm run typecheck` + load unpacked in Chrome
  + check at sidepanel width (~400px), dark mode, keyboard-only, reduced-motion.
- **Phases are independently shippable.** Stopping after any phase leaves the
  app strictly better. Suggested commit cadence: one commit per phase (or per
  view during Phase 2 migration).
- **Risk:** Phase 1.3 (per-tab accent) is the only change that could surface
  pre-existing inconsistencies — SIMAN views that hardcode `--color-primary`
  will stay green until grepped and switched to `--accent`. This is expected and
  is part of the phase.

## Out of scope

- No new features, no backend/message changes, no manifest changes.
- No charts work (Priority 10) — no charts in the audited surfaces.
- Full Inter variable-font setup (ship 3–4 static weights only).
- Replacing the two-tab architecture or restructuring navigation beyond the
  breadcrumb.
