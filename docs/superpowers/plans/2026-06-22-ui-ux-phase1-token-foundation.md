# UI/UX Overhaul — Phase 1: Token Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the design-token layer (focus states, reduced-motion, per-tab accent, contrast, type scale, Inter) so 6 of 12 audit findings resolve across the whole sidepanel with CSS-only changes plus one tiny `App.tsx` effect.

**Architecture:** All visual fixes land in `styles.css`; the Inter font loads via `index.html`; the per-tab accent is driven by a `data-active-tab` attribute on `<body>` set from `App.tsx` state. No view/component logic changes beyond that one effect.

**Tech Stack:** Preact + Vite + `@crxjs/vite-plugin`, plain CSS with custom properties.

**Spec:** `docs/superpowers/specs/2026-06-22-ui-ux-overhaul-design.md` (Phase 1 section).

**Testing reality:** This project has **no test runner** — `tsc --noEmit` (`npm run typecheck`) is the only static check, and it does not type-check CSS. So verification is: `npm run typecheck` (catches the `App.tsx` change) + the manual checks spelled out per task. Do not invent tests.

---

## File Structure

- **Modify** `src/sidepanel/styles.css` — focus primitive, reduced-motion guard, per-tab accent rule, `--muted` contrast, type-scale tokens + application, remove three `outline: none` rules.
- **Modify** `src/sidepanel/index.html` — Inter preconnect + stylesheet.
- **Modify** `src/sidepanel/App.tsx` — one `useEffect` syncing `activeTab` to `document.body.dataset.activeTab`.

No other files change in Phase 1. The per-view `--color-primary → --accent` cleanup (spec 1.3 follow-up grep) is deferred to Phase 5 so Phase 1 stays view-file-free.

---

## Task 1: Keyboard focus-visible ring (#1)

**Files:**
- Modify: `src/sidepanel/styles.css` — add global `:focus-visible` block after the `* { box-sizing: border-box; }` rule (currently lines 79–81); remove `outline: none;` from `.mm-search:focus`, `.ph-config__input:focus`, `.arsip-search-input:focus`.

- [ ] **Step 1: Add the global focus rules**

Insert immediately after the `* { box-sizing: border-box; }` block (after line 81):

```css

/* Keyboard focus ring — a11y (Phase 1.1) */
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}
:focus:not(:focus-visible) {
  outline: none;
}
```

- [ ] **Step 2: Remove the three `outline: none` overrides**

These class-scoped `:focus` rules (specificity 0,2,0) would otherwise beat the global `:focus-visible` (0,1,0) and hide the keyboard ring. Remove only the `outline: none;` line from each; keep the `border-color` line.

In `.mm-search:focus` (around line 1932):
```css
/* before */
.mm-search:focus {
  outline: none;
  border-color: var(--accent);
}
/* after */
.mm-search:focus {
  border-color: var(--accent);
}
```

In `.ph-config__input:focus` (around line 2030):
```css
/* before */
.ph-config__input:focus {
  outline: none;
  border-color: var(--accent);
}
/* after */
.ph-config__input:focus {
  border-color: var(--accent);
}
```

In `.arsip-search-input:focus` (around line 2322):
```css
/* before */
.arsip-search-input:focus {
  outline: none;
  border-color: var(--accent);
}
/* after */
.arsip-search-input:focus {
  border-color: var(--accent);
}
```

- [ ] **Step 3: Build and load**

Run: `npm run typecheck` → expected: no errors.
Then: `npm run dev`, reload the unpacked extension, open the side panel.

- [ ] **Step 4: Manual verification**

- Tab through the Nadine home → each focused button / action-card / tab shows a 2px ring in the accent color.
- Click a button with the mouse → no ring appears (mouse focus suppressed).
- In Settings, Tab to the LLM URL input → both the border tint and the keyboard ring show.
- In Mail Merge, focus the search box → keyboard ring shows (this is the `.mm-search` fix).

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/styles.css
git commit -m "fix(a11y): add keyboard focus-visible rings across the panel"
```

---

## Task 2: Reduced-motion guard (#3)

**Files:**
- Modify: `src/sidepanel/styles.css` — add a `prefers-reduced-motion` block right after the `:focus:not(:focus-visible)` block added in Task 1.

- [ ] **Step 1: Add the reduced-motion block**

Insert immediately after the focus block from Task 1:

```css

/* Respect prefers-reduced-motion — a11y (Phase 1.2) */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
  .streaming__cursor {
    animation: none;
    opacity: 1;
  }
}
```

- [ ] **Step 2: Build and load**

Run: `npm run typecheck` → expected: no errors. Reload the extension.

- [ ] **Step 3: Manual verification**

Enable reduced motion. Easiest path: open the side panel, open DevTools → ⋮ (more tools) → Rendering → "Emulate CSS media feature `prefers-reduced-motion`" → set to `reduce`. Then:
- Trigger a summary (✨ Ringkas) → the streaming cursor no longer blinks (steady).
- Navigate between views → no `fade-in` slide; cards appear instantly.
- Open a modal → no slide-up; appears instantly.
Disable the emulation → animations return.

- [ ] **Step 4: Commit**

```bash
git add src/sidepanel/styles.css
git commit -m "fix(a11y): respect prefers-reduced-motion"
```

---

## Task 3: Per-tab accent via body data attribute (#8)

**Files:**
- Modify: `src/sidepanel/App.tsx` — add a `useEffect` after the main mount effect (currently ends at line 98).
- Modify: `src/sidepanel/styles.css` — add per-tab `--accent` rules after the `--siman-accent` `:root` block (currently around line 2635–2638).

- [ ] **Step 1: Add the sync effect in `App.tsx`**

`useEffect` is already imported on line 1. Immediately after the existing mount effect's closing `}, []);` (line 98), add:

```tsx
  // Sync active tab to <body> so CSS can scope --accent per tab (Phase 1.3).
  useEffect(() => {
    document.body.dataset.activeTab = activeTab;
    return () => {
      delete document.body.dataset.activeTab;
    };
  }, [activeTab]);
```

- [ ] **Step 2: Add the per-tab CSS rules**

The `--siman-accent` `:root` block currently reads (around line 2635):
```css
:root {
  --siman-accent: #2a5a8a;
  --siman-accent-hover: #1e4a78;
}
```
Immediately after that block, add:

```css

/* Per-tab accent: SIMAN screens use blue, Nadine uses green (Phase 1.3).
   --accent still defaults to --color-primary in :root above as a fallback
   until JS sets the body attribute. */
body[data-active-tab="nadine"] {
  --accent: var(--color-primary);
}
body[data-active-tab="siman"] {
  --accent: var(--siman-accent);
}
```

- [ ] **Step 3: Build and load**

Run: `npm run typecheck` → expected: no errors (this is the task typecheck actually guards). Reload the extension.

- [ ] **Step 4: Manual verification**

- Nadine tab: primary buttons, active tab underline, action-card press tint are **green** (`--color-primary`).
- SIMAN tab (click 🏛 SIMAN): primary buttons, `.btn--primary`, active states, `.arsip-*` accents are now **blue** (`--siman-accent`). Before this change they were green inside SIMAN.
- DevTools: on `<body>` confirm `data-active-tab="siman"` / `"nadine"` toggles with the tab.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/App.tsx src/sidepanel/styles.css
git commit -m "feat(theme): scope --accent per tab (SIMAN blue / Nadine green)"
```

---

## Task 4: Raise muted-text contrast (#4)

**Files:**
- Modify: `src/sidepanel/styles.css` — light-mode `--muted`.

- [ ] **Step 1: Darken light-mode `--muted`**

In the light-mode `:root` block, change line 7:
```css
/* before */
  --muted: #6b7c73;
/* after */
  --muted: #5b6b62;
```
This raises contrast on white from ~4.4:1 to ~5.6:1 (clears the 4.5:1 AA bar for the 11–12px hint/label/meta text that uses `--muted`).

Dark-mode `--muted:#7a9484` on `--surface:#1c2420` already measures ~4.8:1 — **leave it unchanged**.

- [ ] **Step 2: Build and load**

Run: `npm run typecheck` → expected: no errors. Reload.

- [ ] **Step 3: Manual verification**

- Light mode: `.hint`, `.row__label`, license meta lines read clearly (slightly darker than before).
- DevTools → inspect a `.hint` element → run the contrast checker on its color vs `--surface`; expect ≥ 4.5:1 (target ~5.6:1).
- Dark mode: confirm no regression (unchanged).

- [ ] **Step 4: Commit**

```bash
git add src/sidepanel/styles.css
git commit -m "fix(a11y): raise muted-text contrast to 5.6:1 (was 4.4:1)"
```

---

## Task 5: Type-scale tokens + apply to core primitives (#9)

**Files:**
- Modify: `src/sidepanel/styles.css` — add tokens to `:root`; apply to core primitives; raise the 10px floor.

- [ ] **Step 1: Add the type-scale tokens**

In the light-mode `:root` block, insert after the `--mono:` line (line 27, before the `/* legacy compat */` comment):
```css
  --text-xs: 11px;
  --text-sm: 12px;
  --text-base: 13px;
  --text-md: 14px;
  --text-lg: 15px;
  --text-xl: 17px;
```

- [ ] **Step 2: Apply tokens to core primitives**

Replace these hardcoded sizes with the tokens (these are the high-traffic primitives; the long tail stays for Phase 5):

`body` (line 90):
```css
/* before */  font-size: 14px;
/* after  */  font-size: var(--text-md);
```

`.panel__title` (line 141):
```css
/* before */  font-size: 15px;
/* after  */  font-size: var(--text-lg);
```

`.card__title` (line 338):
```css
/* before */  font-size: 13px;
/* after  */  font-size: var(--text-base);
```

`.hint` (line 489):
```css
/* before */  font-size: 12px;
/* after  */  font-size: var(--text-sm);
```

`.row__label` (line 377):
```css
/* before */  font-size: 12.5px;
/* after  */  font-size: var(--text-sm);
```

The effective `.btn` definition (the later one, line 1186):
```css
/* before */  font-size: 13px;
/* after  */  font-size: var(--text-base);
```

- [ ] **Step 3: Raise the 10px floor**

`.tab-bar__label` (line 1021):
```css
/* before */  font-size: 10px;
/* after  */  font-size: var(--text-xs);
```

- [ ] **Step 4: Build and load**

Run: `npm run typecheck` → expected: no errors. Reload.

- [ ] **Step 5: Manual verification**

- Visual sweep: body text, card titles, hints, row labels, buttons look unchanged in size (the tokens equal the originals) — this step is about introducing tokens, not resizing.
- Tab bar labels are now 11px (was 10px) — slightly more legible.
- Confirm nothing obviously shifted size.

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/styles.css
git commit -m "style: introduce type-scale tokens; raise 10px floor to 11px"
```

---

## Task 6: Load Inter (#11)

**Files:**
- Modify: `src/sidepanel/index.html` — add font preconnect + stylesheet in `<head>`.

- [ ] **Step 1: Add the font links**

In `src/sidepanel/index.html`, the `<head>` currently is:
```html
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Asguard</title>
  </head>
```
Replace with:
```html
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      rel="stylesheet"
      href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
    />
    <title>Asguard</title>
  </head>
```
`--font` in `styles.css` already lists `"Inter"` first with a `system-ui` fallback, so no CSS change is needed.

- [ ] **Step 2: Build and load**

Run: `npm run typecheck` → expected: no errors. Reload.

- [ ] **Step 3: Manual verification**

- DevTools → Elements → pick body → computed `font-family` first entry is `Inter`.
- In the Network tab, confirm `fonts.googleapis.com` + `fonts.gstatic.com` requests succeed.
- Disconnect network, reload → text still renders via the `system-ui` fallback (no invisible text; `display=swap`).

- [ ] **Step 4: Commit**

```bash
git add src/sidepanel/index.html
git commit -m "feat: load Inter (was silently falling back to system-ui)"
```

---

## Task 7: Full Phase 1 verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Clean build**

```bash
npm run typecheck && npm run build
```
Expected: typecheck passes; build writes `dist/` with no errors.

- [ ] **Step 2: Reload unpacked extension from `dist/` and sweep**

Confirm all six fixes together:
1. **Focus:** Tab everywhere → visible rings; mouse click → none.
2. **Reduced-motion:** DevTools Rendering emulation → no animation/cursor blink.
3. **Per-tab accent:** SIMAN blue, Nadine green; `<body data-active-tab>` toggles.
4. **Contrast:** `.hint` ≥ 4.5:1 (light).
5. **Type tokens:** no 10px text; sizes otherwise unchanged.
6. **Inter:** computed font-family = Inter; offline fallback intact.
Check in **both light and dark** mode.

- [ ] **Step 3: Note Phase 1 completion**

Phase 1 resolves audit findings **#1, #3, #4, #8, #9, #11**. Remaining (#2 icons, #5 status labels, #6 targets, #7 wayfinding, #10 inline styles, #12 aria-live) are Phases 2–5 and get their own plans.

---

## Self-Review

**1. Spec coverage (Phase 1 section of the spec):**
- 1.1 focus → Task 1 ✓
- 1.2 reduced-motion → Task 2 ✓
- 1.3 per-tab accent → Task 3 ✓ (body data-attr refinement over spec's "panel root class" — DRY: one effect + one CSS rule instead of editing ~12 return branches; noted in plan)
- 1.4 contrast → Task 4 ✓
- 1.5 type tokens → Task 5 ✓ (long tail explicitly deferred to Phase 5, matching spec)
- 1.6 Inter → Task 6 ✓
- Phase 1 verification → Task 7 ✓

**2. Placeholder scan:** No TBD/TODO/"add appropriate ...". Every code step shows exact before/after. The only intentional "fill at implementation time" is in the *spec* (Phase 2 Lucide paths), not in this plan.

**3. Type/identifier consistency:** `--accent`, `--color-primary`, `--siman-accent`, `--muted`, `--text-*` token names are used consistently and all exist in `styles.css`. `activeTab` state and `useEffect` import exist in `App.tsx`. `data-active-tab` matches between the JS setter and the CSS selectors.

**4. Deferred item recorded:** spec 1.3's "grep SIMAN views for `--color-primary` → `--accent`" is moved to Phase 5 (this plan is view-file-free by design). Stated in the File Structure section so it isn't lost.
