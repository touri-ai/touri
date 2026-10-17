fix(runtime): conclude tool turns with confirmed results

## Problem

File tasks could finish after their tool or approval cards with only a preamble. Users could not tell what had happened. Text following a tool was merged into the preamble's part, and buffered redaction tails could cross tool boundaries. Session handoff notices also exposed internal provider bookkeeping in the main transcript.

## Fix

- Instruct every bot to close tool work with one or two sentences in the user's language, naming confirmed results and locations or explaining the blocker.
- Before publishing a successful reply as complete, append a Portuguese or English fallback when no assistant text follows the final tool or approval. Use only this turn's recorded outcomes; report failed, denied and unconfirmed actions honestly. List file paths only for confirmed file changes or successful native file tools.
- Keep post-tool text in a separate part, including when a provider reuses a text item ID. Flush buffered text at semantic boundaries and before terminal publication; a provider completion frame alone does not complete the message.
- Replace approval timing with plain Portuguese and English for local and VM bots. Keep session handoff notices in collapsed technical details.

Contract edits change copy only; no schema or persisted data format changes.

## Evidence

- Before the production fix, the initial regression run produced six sidecar failures and one rendered transcript failure against the original implementation. The file-task reply contained only the preamble, and closing text occupied the earlier part.
- `bun test --timeout 15000 sidecar/test/runtime/turn-conclusion.test.ts sidecar/test/runtime/instructions-language.test.ts sidecar/test/runtime/notices.test.ts sidecar/test/runtime/permission-continuation.test.ts sidecar/test/runtime/command-progress.test.ts` — 53 passed. Covers localized fallback, existing conclusions, reused item IDs, late final deltas, stored terminal snapshots, uncertain outcomes, approvals and output timers.
- `bun test sidecar/test/security/sec-tools.test.ts -t 'B07 .*credentials|B07 .*matches|B07 short credentials'` — 4 passed; streaming credentials and protocol identifiers remain protected.
- `bunx tsc --noEmit -p tsconfig.base.json` — passed.
- `bunx biome check` on all 13 changed TypeScript/TSX files — passed.
- `cd ui && NODE_OPTIONS=--max-old-space-size=768 timeout 90s bunx vitest run --maxWorkers=2 --pool=threads --no-isolate test/session-notice.test.tsx` — 1 passed. The rendered transcript hides the internal handoff notice, keeps its original text in collapsed technical details and reveals it on demand.
- An initial 5-second timeout in the existing project-continuation test passed in isolation on both this branch and a temporary `origin/main` snapshot; the final relevant sidecar run also passed it.
- Broader UI validation: `cd ui && bunx vitest run --maxWorkers=2 test/session-notice.test.tsx test/setup-approvals.test.tsx test/approval-notice.test.tsx` encountered timeouts. Local/VM approval copy, English translations and 26 of 27 setup checks passed; the existing asynchronous project-approval check timed out. A separate `timeout 90s bunx vitest run --maxWorkers=2 --no-file-parallelism test/setup-approvals.test.tsx` also timed out in a clean temporary `origin/main` snapshot before reporting tests. An isolated-cache retry did not resolve this runner limitation; the full UI suites remain unverified. The focused transcript regression passed with the thread pool as recorded above.

Native macOS QA was unavailable on this Linux runner. No latency benchmark was performed.

VISION promise served: **#7 — Calm, clear, native**: readable outcomes and approvals in the user's language. **#3 — Nothing is lost**: final text and tool outcomes remain ordered and persisted in history.
