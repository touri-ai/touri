# Chat transcript evidence

These captures use synthetic notes and the production chat and Markdown components. The long turn contains 40 actions (10 file reads, commands, searches and edits), reasoning between actions, a final answer and a diagram. No real conversations or application data are used.

| Scenario | Before | After |
| --- | --- | --- |
| Long turn, dark | [Capture](before-long-dark.png) | Pending review/CI capture |
| Long turn, light | [Capture](before-long-light.png) | [Capture](after-long-light.png) |
| Waiting, desktop | [Capture](before-waiting-1100.png) | [Capture](after-waiting-1100.png) |
| Waiting, narrow viewport | [Capture](before-waiting-390.png) | [Capture](after-waiting-390.png) |
| Diagrams, dark | [Capture](mermaid-before-dark.png) | [Capture](mermaid-after-dark.png) |
| Diagrams, light | [Capture](mermaid-before-light.png) | [Capture](mermaid-after-light.png) |

The included captures were produced before the owner paused the test infrastructure. They show the synthetic fixture, not a completed validation run for the final commit. The remaining dark long-turn capture, production CSP checks and desktop engine checks must run in review/CI.

The browser tests build production assets, measure initial static JavaScript and CSS imports against a 400,000-byte gzip budget, and serve the result under the unchanged desktop CSP. They cover lazy loading, theme changes, source copying, code fallback, keyboard scrolling and SVG rendering. The bundle measurement and desktop engine capture are generated under the ignored evidence directory when those checks complete; neither result is claimed here.

On resumption, `touri-test.sh typecheck biome vitest e2e` returned: `tests are PAUSED on this box by the owner (test infra being fixed): skipped, treat as not run`. No alternate test runner was used. The final typecheck, formatting/lint, unit, browser and production build checks remain pending review/CI. Frozen dependency installation completed successfully.

The tests generate captures in the ignored `docs/qa/chat-transcript` directory. Reviewed evidence is copied here. `CHAT_TRANSCRIPT_PHASE=before` records the original renderer with the same fixtures; `after` runs the regressions. `TOURI_E2E_PORT` reserves a separate local fixture port; `TOURI_E2E_CHANNEL` selects the installed browser. Use the serialized test gate for every run and request a fresh gate result when changing the phase or test selection.
