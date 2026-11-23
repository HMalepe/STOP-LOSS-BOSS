# 12: Design system, "The Observatory"

Order Desk's visual language (owner decision 2026-11-23: ORBIT's visual direction, live trading kept, phone-first).
A quiet, engineered instrument panel: Bloomberg's information discipline, Linear's interaction craft, Stripe's numerical clarity.
Live review sheet: `/system` (sample data). Screens: `docs/screens/stage1/`.

## Rules
1. **Signal over decoration.** Hairline borders and lighter surfaces for structure; no shadows-as-style, no gradient wallpaper, no glass.
2. **One accent** (glacial periwinkle `accent`) for primary actions, focus and selection. Nothing else is blue-violet.
3. **Colour never carries meaning alone.** P/L has a sign and an arrow; states have words; the mode badge has a label and a dot.
4. **Numbers are mono, tabular, slashed zero** (`.num`). Columns align; prices never jitter.
5. **Loud only where it must be:** LIVE badge (pulsing dot) and Close All Now (`panic`, solid red). Everything else is calm.
6. **Phone first:** 48 px targets, primary actions in the thumb zone (fixed dock + tab bar), one task per screen, no sideways-scrolling tables
   (rows on phones, tables from `sm`). Desktop: left rail, readable max width.
7. **Every state is designed:** loading (skeletons), empty, error, offline, halted, disconnected.
8. **Motion explains state**, ≤ 150 ms, eased; `prefers-reduced-motion` turns it off.

## Tokens (`src/app/globals.css`, the only source)
Surfaces `ink · bg · surface · raised · overlay`, structure `line · line-strong`, text `text · subtle · muted · faint`,
accent `accent · accent-strong · accent-ink`, semantics `up · down · warn · info · danger`, modes `mock · demo · live`.
Type: Geist Sans / Geist Mono (self-hosted, no network at build). Radii: sm 6 · md 8 · card 12. Spacing: 4/8 grid, `tap` = 48 px.

## Components (`src/ui`)
AppShell (TopBar, BottomNav / SideNav, bottom dock), PageHeader, Panel, Button (`primary · secondary · ghost · danger · panic`,
loading/disabled), ModeBadge, StatusBadge, Connection (link + freshness), Metric (label, value, unit, trend, hint, skeleton),
Segmented (ARIA tablist, arrow keys), EmptyState, ErrorState, OfflineBanner, HaltedBanner, Logo/Wordmark.
Coming with the screens (Phase 07 M1–M5): PriceInput, ArmButton, ConfirmSheet, ProgressView, ResultTable, Toast.
