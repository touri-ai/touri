The mock app shows a bot requesting access during its original task. Approval requires an explicit click; Enter leaves access disabled. Approval updates the bot setting and the mock continues the task without a second user message. Denial keeps access off and explains where to enable it later.

The computer screenshot uses a supported-host mock. The sidecar tests reject Linux host screen control, unavailable isolated computers and unsupported servers. Browser activation selects the bot's isolated browser. Routines, delegated runs, stale approvals and canceled turns cannot activate access. Computer activation never offers a standing grant.

- [Browser, narrow window](browser-390.png)
- [Browser, wide window](browser-1440.png)
- [Computer approval](computer.png)

Generate the screenshots with `CAPABILITY_CAPTURE=$PWD/docs/qa/capability-request bunx playwright test --config ui/playwright.config.ts ui/test/e2e/capability-request.spec.ts --workers=1`.

The eight capability UI regression tests fail against the original main revision and pass with this change. The sidecar continuation test uses the real store, approval bridge and runtime with a mock provider and browser tool: no page opens before consent; approval opens the original URL on exactly one continuation; denial leaves both the setting and browser unchanged.
