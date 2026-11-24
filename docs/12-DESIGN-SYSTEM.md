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

## Facelift audit (ORBIT 06 + 08), 2026-11-24
Scored against the pack's creative-director gate, before → after this pass.

| Area | Before | After | What changed |
|---|---|---|---|
| Visual identity | 8 | 8 | Already set in stage 1; noise trimmed (no "done" under every tick) |
| Information architecture | 6 | 8 | History and Settings were placeholders; now real. Command palette (Ctrl/Cmd+K + visible button) |
| Data visualisation | 7 | 7 | Segmented outcome bars; charts arrive with Phase 09 (no chart without a question to answer) |
| Interaction design | 7 | 8 | Sortable positions with a visible order; kill switch screen; inline re-auth instead of a dead end |
| Accessibility | 6 | 8 | Metric definitions moved from mouse-only `title` to a keyboard/touch Help popover; palette is a combobox/listbox |
| Responsive quality | 8 | 8 | Phone rows, never squashed tables; desktop rail |
| Engineering quality | 8 | 8 | Every new path in e2e; display logic unit-tested |
| Data trust | 6 | 8 | Every timestamp names its timezone; "as of" on live data; history never says "complete" without how it ended |

Deliberate differences from the pack: live trading is kept (owner decision), so the "PAPER" banner is the mode badge
(MOCK/DEMO/LIVE, LIVE pulses); phone-first, so the sidebar doesn't collapse (phones use the bottom bar instead).
