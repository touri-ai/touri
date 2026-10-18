# Server-mode client retention (#246)

The regression workload seeds 30 generated bots in a mock API, opens bot 0's completed conversation,
then delivers 40 turns from each of the other 29 bots in two waves. Each turn carries
streaming prose, reasoning, a tool result, run state, and unread metadata. Histories are
reconstructed on request so the fixture does not retain the event payloads being measured.

- `ui/test/workspace-retention.test.tsx` requires serialized retained workspace state below
  1 MiB after each wave and after visiting every bot and returning to bot 0. It also checks
  history reload, failed/canceled turns, full tool results, pending approvals, active streams,
  late responses, pending-send restoration, stream-buffer overflow, and group sender identity.
- `ui/test/e2e/workspace-retention.spec.ts` drives the real app, collects Chromium garbage
  before sampling heap, and limits growth above the loaded-app baseline to 8 MiB. It attaches
  numeric measurements and checks that reopening a visited bot fetches history again.

Run these through the authorized serialized test gate. On 2026-10-18, all seven new unit regressions
failed with `origin/main` workspace code and passed with this fix. The complete affected Vitest
selection passed all 87 files (1,068 tests), along with typecheck and Biome. No sidecar files were
selected. The UI production build passed inside the browser gate.

Chromium retained heap after garbage collection, measured in bytes with the same generated workload:

| Workspace code | Loaded app | After 20 background turns per bot | After 40 background turns per bot |
| --- | ---: | ---: | ---: |
| `origin/main` | 14,083,108 | 28,102,232 | 39,621,928 |
| Fix | 16,115,204 | 16,989,280 | 17,166,176 |

Growth after 1,160 background turns fell from 24.4 MiB to 1.0 MiB, below the 8 MiB budget. The
browser test also passed its history-reopen checks. These are synthetic Chromium measurements;
they do not measure native RSS or real network transport.

The full browser selection ran 287 tests: 266 passed and 21 failed across nine existing files.
Running those nine files against `origin/main` reproduced all 21 failures (24 passed, 21 failed).
The failing test names matched exactly; this change introduced no browser failures.

Only the selected transcript keeps full content. Background activity keeps five recent message
slots per conversation plus outstanding approvals, deliveries, and streams. Completed run
history is retained for the selected conversation; other conversations retain active runs and
their latest run. Pending requests and live work are intentional exceptions to fixed counts.
History remains durable on the server, including branches, tool results, failed and canceled
turns. Reopening requests all messages and runs. A slow selected-history request buffers at
most 256 KiB of serialized stream events (estimated as UTF-16); overflow discards that buffer
and requests a fresh snapshot. Closing that conversation discards the buffer immediately.

Inspection found no TypeScript socket replay queue: it keeps a sequence cursor and dispatches
events to subscribers. Existing notification deduplication and response timing caches have
limits. Avatars already stop their frame loops when the page is hidden or the avatar is
offscreen. Native relay inspection showed streamed HTTP responses and awaited socket sends
with size/time limits. No Rust or macOS-only code was changed.

Linux cannot measure the macOS WebContent, Networking, or GPU services. The 150 MB total native
idle RSS target remains unverified. On macOS, use a disposable desktop instance paired to a
30-bot test server, finish one visible reply, run background events, and sample the shell and
its associated services every 30 seconds using the same workload and build settings before
and after. Large open transcripts, outstanding work, routine history, and native allocation
remain outside the fixed background-transcript budget.
