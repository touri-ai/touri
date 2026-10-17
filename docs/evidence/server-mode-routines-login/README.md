# Server routines and provider login

The screenshots show the running application with synthetic mock data. The login challenge is synthetic; no account was authenticated.

- [Bot routines](routines.png): opening a bot's routines goes directly to its filtered list and focuses the region.
- [Server login](server-login.png): the provider URL opens on the current device, the device code can be copied or selected, and retry/cancel are available.
- [Server login at a 390 px viewport](server-login-mobile.png): the same controls fit without horizontal overflow.

Fake CLI tests exercise Codex device authorization, Claude Code authorization links and returned codes, and OpenCode device links, returned codes and method selection. They cover chunked output, private credential capture, timeout, retry and process cancellation. Browser-only server login methods cannot be confirmed. UI regressions cover each bot routine entry, focus after settings close, copying with a manual fallback, and cancellation while closing the login view.

The new navigation and login regressions fail against the unmodified implementation on main.
