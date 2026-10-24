# Composer streaming: recovery scans (#201)

Base: `origin/main` at `2d0c718f6bf652fbc4f7feb55f137743bb2111a6`.
Measurements: 2026-10-24, Node 22.23.1, Vitest 3.2.7, one test process.
All content is generated synthetic data.

## Measured issue and change

`VirtualMessageList` searched runs and messages for a later successful answer for
**every mounted row on each delta**, before the memoized message bubble could bail
out. The resulting `recovered` flag is only displayed when `runErrorFor` returns
an error, which requires `message.status === "failed"`.

The production change adds that status guard around the existing recovery searches.
Failed messages retain the same thread, channel-request and timestamp matching.
Normalization of a saved streaming message against a finished run happens before
this guard, so interrupted replies still receive recovery presentation.

This removes one measured source of redundant work. It does not change the other
per-row lookups, element construction, App/sidebar/composer renders, streaming
batching, history, drafts, persistence, approvals, cancellation or layout.

## Repeatable red/green regression

`ui/test/streaming-recovery-work.test.tsx` mounts the real list with either 26 or
500 messages. The shared fixture contains alternating command/read-file tool
parts (156 / 3,000 total), prior long Portuguese answers with 60 items and an
eight-row table, and run records. The last historical reply/run is made active;
the remaining 12 / 249 runs are finished. Synthetic scroll geometry keeps the
500-message list at its end without requiring browser layout.

An observed-property pass counts historical run completion-time reads across 30
identical text deltas. A separate pass uses ordinary run fields, measuring process
CPU with `process.cpuUsage` and synchronous React render durations with `Profiler`.
CPU measurement excludes the observed-property overhead and the final wait for
coalesced Markdown. Nested React updates account for more commits than deltas.

Both measured runs used identical test code and synthetic data. Only `ChatPanel.tsx`
was temporarily restored from `origin/main` for red, then restored to the fix.
The final streamed-content assertions and both failure-recovery cases passed on
the baseline; only the two zero-read assertions failed. All four pass with the fix.
The failure cases cover saved failed replies and streaming replies normalized
against interrupted runs, including recovery from a later saved message without
a run record.

| Messages | Historical reads, before → after | Process CPU ms, before → after | React render ms, before → after | Render p99 ms, before → after | Commits, before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| 26 | 13,140 → 0 | 343.855 → 354.732 | 175.877 → 178.857 | 7.773 → 6.244 | 75 → 75 |
| 500 | 556,605 → 0 | 569.010 → 535.437 | 396.298 → 317.471 | 30.407 → 23.928 | 45 → 45 |

A later green validation invocation of the same workload recorded 358.647 /
633.561 ms process CPU and 176.333 / 683.543 ms React render time for 26 / 500
messages, with render p99 8.666 / 81.781 ms. Recovery reads remained zero in both.
This variation rules out treating the favorable isolated pair as a demonstrated
steady improvement in composer latency.

These are samples, not statistical evidence of a general latency
improvement. CPU includes runtime/GC variability; React durations use elapsed
time and can include host scheduling. The smaller case's CPU/render totals were
slightly worse. The deterministic evidence is removal of unnecessary recovery
reads. These JSDOM render measurements do not establish browser frame budgets or
physical input/display latency.

## Browser evidence

The existing `streaming-history.spec.ts` now uses 500 generated prior messages,
3,000 historical tools and 250 completed runs, plus the mock seed and new streaming
turn. It types real keyboard events at 1440×900 and 390×844, compares idle typing
with continuous streaming (counting keys while the turn is active), and records
renderer task time, React component renders, input-to-next-frame p99/max and long
tasks. It checks the complete draft,
60 list items and eight table rows after expanding the completed answer. The
streaming turn includes command activity and preserves that part during deltas.

The browser workload ran against the same base and the fix, restoring only
`ChatPanel.tsx` for the baseline. Each run used one bundled Chromium worker and
the Vite development harness on a shared Linux host. The separate production UI
build passed. The fixture sends 20-character deltas every 30 ms, types 73 idle
characters and 219 characters during the streaming trial, and counts latency
samples only while the reply is active. The fixed phone run recorded 207 active
typing samples; the other runs recorded 219.

| Viewport | Idle input-to-frame p99 ms, before → after | Streaming input-to-frame p99 ms, before → after | React render p99 ms, before → after | Long tasks, before → after | Trial duration seconds, before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1440×900 | 15.2 → 15.5 | 51.9 → 52.7 | 44.2 → 39.7 | 92 → 82 | 25.06 → 23.84 |
| 390×844 | 14.7 → 22.6 | 37.4 → 33.9 | 23.3 → 23.3 | 6 → 4 | 19.02 → 17.33 |

The draft, complete 60-item answer and eight-row table survived both runs. The
fixed run still rendered AppContent 399 times per stream and Sidebar 400 times
on desktop. These samples do not demonstrate a repeatable overall typing-latency
improvement or compliance with the 16 ms frame budget. They support the scoped
removal of unnecessary recovery reads. Remaining rendering/layout work needs
further measurement with production React and representative devices.

Renderer task time is elapsed task duration, not process CPU; the next animation
frame is a presentation opportunity, not a physical display measurement. No raw
profiles or traces are published.

## Reproduction

Run the checks sequentially:

```sh
bun install --frozen-lockfile
bunx tsc --noEmit -p tsconfig.base.json
bunx biome check .
(cd ui && NODE_OPTIONS=--no-experimental-webstorage bunx vitest run test/streaming-recovery-work.test.tsx)
(cd ui && bunx playwright test test/e2e/streaming-history.spec.ts --workers=1)
bun --cwd ui build
```

The targeted UI selection passed 102 tests in 10 files. The browser selection
covered rich/sparse streaming, composer performance, channel branches, recovery
layout and restart recovery. Eighteen of nineteen cases passed on the first run.
The throttled composer case exceeded its handler p95 limit once (20.8 ms versus
16 ms). The baseline passed at 15.4 ms; a fresh fixed run passed
at 11.5 ms, with all three cases in that file passing. No limit was changed.
The fresh fixed composer case rendered only Composer for its 20 keystrokes,
with React render p95 3.2 ms, next-frame p95 25.8 ms and initial load 4.81 seconds
under four-times CPU throttling.

No Rust code changed; Rust/macOS checks are left to the supported environment.
Inspected mock screenshots accompany the PR at desktop and phone widths.
The final unfiltered selection passed typecheck, Biome, one selected
sidecar test file, and all 1,226 UI tests across 103 selected files. The browser
selection above contains nineteen cases across six selected spec files; its
one timing failure passed the fresh rerun without changing the limits.

This optimization addresses redundant recovery lookups only. The broader
streaming responsiveness work remains tracked in #201.
