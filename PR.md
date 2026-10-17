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

## Approval UX follow-up

1. Approval reminders now say “{bot} pede sua aprovação: {summary}” / “{bot} asks for your approval: {summary}”. They preserve the summary's capitalization and compact folder paths, without adding another action verb.
2. Settings, folder/project approvals, VM hints and setup results consistently refer to the next message in Portuguese and English. Shared contract changes affect copy only; no schema or stored format changes.
3. Model help asks for a model name accepted by the named provider. Model defaults and the OpenCode installation hint also use plain provider names.
4. Answering an approval no longer opens its tool group. Pending approval cards remain visible; manual expansion stays under the user's control through later output updates. After a resolution moves the card into a collapsed group, keyboard focus goes to its summary instead of hidden command details.

Validation:

- Before the fix, `cd ui && NODE_OPTIONS=--max-old-space-size=768 timeout 90s bunx vitest run test/tool-cards.test.tsx --maxWorkers=2 --testTimeout=20000 -t 'keeps terminal cards collapsed'` failed both new approval/denial regressions because the group had `open=""`. Both pass with the fix; the server-update race test also verifies focus on the collapsed summary and retention of the decision timestamp.
- Final UI run: `cd ui && NODE_OPTIONS=--max-old-space-size=768 bunx vitest run test/{approval-notice,setup-approvals,approval-content,settings-simplification,qa-settings-setup,r8-settings,bot-network-settings,tool-cards,model-picker,bot-folders,composer-project,opencode,approval-navigation,approval-sync,notification-delivery,browser-tool-cards}.test.tsx --maxWorkers=2 --testTimeout=20000` — **229 passed across 16 files**. Includes rendered copy, both languages, compact paths, approval/resume and manual disclosure behavior.
- `bunx tsc --noEmit -p tsconfig.base.json` — passed.
- `bunx biome check` with all 25 changed TypeScript/TSX files — passed with one existing unused `readOnly` parameter warning in `BotFolderSettings.tsx`; the same warning was reproduced from `origin/main`.
- `bun test --timeout 20000 sidecar/test/projects/setup-tools.test.ts` — all 37 tests stopped at server startup with `EADDRINUSE` on automatic port allocation. The local and VM setup tests reproduced the same startup failure in a temporary `origin/main` snapshot. Their assertions remain unverified in this environment.
- `git diff --check` — passed. Native macOS QA remains unavailable on this Linux runner. No latency benchmark was performed.

VISION promises served: **#7 — Calm, clear, native** and **#4 — The user is in charge**: readable approvals and deliberate access to command details.
