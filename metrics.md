# Live browser preview measurements

## Sampling and frame handling

- The live preview samples no faster than once every 700 ms. Each new sample waits for the previous worker response, so a slow frame cannot queue more decode work.
- Hiding the card or document stops sampling and terminates the worker. Completing the turn also stops sampling while retaining the final screenshot attachment.
- The worker validates JPEG data URLs up to 2.1 million characters and source images up to 8 million pixels, then produces a 640 × 400 JPEG thumbnail. The UI test checks that the resulting data URL is under 250,000 characters.

## UI responsiveness

`browser-activity.spec.ts` passed all 8 desktop, phone, theme, and fallback cases. In its desktop dark measurement window of 2.2 seconds at the 700 ms cadence:

- Preview requests: 3
- Maximum observed UI long task: 0 ms
- Long task observer: available
- Target: less than 50 ms per long task

## Sidecar event loop

`sidecar/test/browser/index.test.ts` sent 5 sequential preview requests at 1 Hz through the preview route. The fake browser engine returned a synthetic JPEG data URL with a 1,500,000-character base64 payload; the measured JSON response was 1,500,093 bytes.

- Maximum event-loop delay: 4.45 ms
- 99th percentile event-loop delay: 2.15 ms
- Target: less than 50 ms

## Check results

- UI typecheck and Biome: passed
- UI Vitest: 1,076 tests passed
- Sidecar browser tests: 7 passed
- UI production build: passed
- UI e2e: 509 passed, 7 failed out of 516; all 8 browser activity cases passed

The e2e failures were in `bot-menu-clipping.spec.ts` (two screenshot size differences), `mermaid-csp.spec.ts` (414,685 compressed bytes against a 400,000-byte limit), `r4.spec.ts` (notifications button not found after opening the approval center), and `routine-conversation.spec.ts` (three selected-thread label expectations).
