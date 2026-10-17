# Small-window dialogs

Fixes #163. These screenshots use the Portuguese UI with local mock data and the same application components and CSS as the desktop app.

The routine editor was inside the page transition’s stacking context, below the sidebar. Animated modal wrappers also had zero height. Dialogs now escape those ancestors through a shared portal layer; the animated wrapper remains a real, viewport-sized box. Confirmations opened inside the native mobile sidebar stay in its top layer. Nested dialogs escape their parent panel’s transform.

The routine body scrolls independently of its header and actions. Settings navigation and panes shrink to the available height, so their tabs cannot grow over the footer. Dialog roles, labelled controls, initial focus, keyboard trapping, return focus, and native selects are retained.

| Evidence | Screenshot |
| --- | --- |
| Before: sidebar above the routine panel, 900 × 560 | [Before](before-routine-900x560.png) |
| After: opaque panel above the dimmed sidebar | [After](after-routine-900x560.png) |
| After: final advanced fields reached while header/actions stay visible | [Scrolled body](after-fields-900x560.png) |
| Before: animated settings at 900 × 560 | [Mid-animation](before-mid-animation-900x560.png) |
| After: animated settings at 900 × 560 | [Mid-animation](after-mid-animation-900x560.png), [settled](after-settled-900x560.png) |
| After: review and all actions at 390 × 844 | [Mobile](after-review-390x844.png) |

Run the layout suite from `ui`: `bunx playwright test --config playwright.dialogs.config.ts`.

It covers 800 × 600, 1024 × 700, 1280 × 800, 390 × 844 and 900 × 560 in both browser engines. Assertions check computed panel alpha = 1, full-viewport dimmed backdrops, hit testing above the sidebar, viewport margins, reachable last fields and every footer button, native select interaction, nested permission/deletion confirmations, focus return, and mid/settled animation geometry. Screenshots are also saved per test.

On the original base, the WebKit routine regression fails the sidebar coverage assertion and the motion regression finds a static, zero-height wrapper.

VISION.md: promise #7, calm, readable and accessible; promise #4, people can review their schedules and permission decisions.
