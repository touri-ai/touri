# Issue 429: visual evidence

The category breadcrumb now says Bots; the bot name stays in its level-one heading. The sidebar and phone menu still provide bot navigation.

All screenshots use the running React app with `createMockApi`, synthetic conversations and a synthetic draft. No production account, user database, microphone audio or personal filesystem content was loaded. The fixed clock is 2026-10-18 12:00 UTC.

Baseline: `2aaf77cb`. Desktop: 1440 × 900. Phone: 390 × 844. Both light and dark themes. Files named `before-*` show the baseline; `after-*` show this branch. The JSON files record viewport overflow and selected-label layout.

Open `/test/e2e/home-harness.html` to reproduce the mock app.

| View | Before | After |
| --- | --- | --- |
| 1440 px, light | ![Before 1440 light](before-1440-light.png) | ![After 1440 light](after-1440-light.png) |
| 1440 px, dark | ![Before 1440 dark](before-1440-dark.png) | ![After 1440 dark](after-1440-dark.png) |
| 390 px, light | ![Before 390 light](before-390-light.png) | ![After 390 light](after-390-light.png) |
| 390 px, dark | ![Before 390 dark](before-390-dark.png) | ![After 390 dark](after-390-dark.png) |
