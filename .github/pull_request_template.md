## Problem

Describe the concrete user problem and how to reproduce it.

## Change

Describe the resulting behavior and relevant implementation choices.

## Evidence

List checks actually run and their results; explain skipped/unavailable checks. Use synthetic data
and include relevant event-loop/UI measurements or a reason they are not applicable.

- [ ] Event loop: nada bloqueante (EVENT_LOOP.md)
- [ ] Security review (SECURITY_REVIEW.md)

## Security review

Read [EVENT_LOOP.md](https://github.com/touri-ai/touri/blob/main/EVENT_LOOP.md) and
[SECURITY_REVIEW.md](https://github.com/touri-ai/touri/blob/main/SECURITY_REVIEW.md).
Complete every row: `OK`, `NA` with a reason, or `RISK (low/medium/high)` with mitigation and
remaining work. Cite files/lines, checks or sanitized artifacts. Any unresolved high risk blocks merge.

| Item | Result | Evidence / reason / mitigation |
| --- | --- | --- |
| DATA-1: output boundaries | | |
| DATA-2: published evidence | | |
| SECRET-1: storage | | |
| SECRET-2: exposure | | |
| SECRET-3: gitleaks scan | | |
| WEB-1: reachability and auth | | |
| WEB-2: browser boundary | | |
| WEB-3: remote deployment | | |
| WEB-4: files and outbound URLs | | |
| HOST-1: command execution | | |
| HOST-2: filesystem scope | | |
| HOST-3: isolation and approval | | |
| HOST-4: writes and privilege | | |
| SUPPLY-1: dependencies | | |
| SUPPLY-2: executable content | | |
| SUPPLY-3: undisclosed behavior | | |
| SUPPLY-4: CI and release | | |
| PROMPT-1: trust boundaries | | |
| PROMPT-2: approval integrity | | |
