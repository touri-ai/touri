# Delete a routine

Issue: [#152](https://github.com/touri-ai/touri/issues/152).
Base: `15a78ba` (the schedule editor is already present).

A person can delete a saved routine from the card's actions, the end of its editor, or the bot's Advanced → Routines tab. Each entry opens the same confirmation. Cancel receives initial focus; Tab stays inside the dialog; Escape cancels and restores focus. A successful deletion moves focus to the routines heading or the bot's routines panel. Failed requests keep the confirmation open for retry.

The server cancels queued executions, including catch-up work, and removes the schedule from SQLite and its caches. A turn that has already started keeps its timeout and can finish. Conversations, messages and provider run records remain. A deleted routine rejects later run/edit requests and stays deleted after restarting the runtime.

## Screenshots

The running UI uses synthetic data. Browser checks cover 1440px and 390px in dark and light themes.

| Entry | Before | After |
| --- | --- | --- |
| Routine card | [Before](before-card.png) | [Desktop](after-card-1440-dark.png), [phone](after-card-390-dark.png) |
| Editor | [Before](before-editor.png) | [Desktop](after-editor-1440-dark.png), [phone](after-editor-390-dark.png) |
| Bot's routines tab | [Before](before-bot-routines.png) | [Desktop](after-bot-routines-1440-dark.png), [phone](after-bot-routines-390-dark.png) |

Confirmation: [desktop, dark](after-confirmation-1440-dark.png), [phone, dark](after-confirmation-390-dark.png), [desktop, light](after-confirmation-1440-light.png), [phone, light](after-confirmation-390-light.png).

The light theme's bot tab is also captured at [1440px](after-bot-routines-1440-light.png) and [390px](after-bot-routines-390-light.png).

## Validation

- The new HTTP regression test fails on the unchanged base: deleting a routine returns 404 instead of 200.
- Three server regression tests pass: the real HTTP route, completion of an active turn with its conversation intact, and cancellation of queued catch-up work with no future execution after restart.
- Seven UI unit tests cover all three entry points, cancellation, keyboard focus, failure/retry, duplicate submissions, an unsaved editor name, and English copy.
- Browser tests delete through all three entry points at both widths. They check the dialog's accessible name and description, zero accessibility violations in the confirmation, keyboard activation, focus restoration, preserved conversation content, and layout bounds.
- The full runtime suite was compared with the base. The existing Linux folder-permission fixture fails on both. A cancellation timing test that timed out in the first run passes on its isolated rerun.

Commands:

```sh
bunx biome check .
bun run typecheck
(cd ui && NODE_OPTIONS=--no-experimental-webstorage bunx vitest run --maxWorkers=2)
bun test sidecar/test/runtime
bun test sidecar/test/runtime/routine-delete.test.ts sidecar/test/runtime/runtime.test.ts --test-name-pattern 'delet|DELETE'
bun --cwd ui build
(cd ui && ROUTINE_QA_THEME=dark bunx playwright test test/e2e/delete-routine.spec.ts --config playwright.screens.config.ts --workers=1)
(cd ui && ROUTINE_QA_THEME=light bunx playwright test test/e2e/delete-routine.spec.ts --config playwright.screens.config.ts --workers=1)
```

VISION promises served: 3 (history remains), 4 (the user controls recurring work), and 7 (clear, accessible Portuguese and English UI).
