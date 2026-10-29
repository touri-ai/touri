# External watchdog deadlines

A run's age alone does not prove that it stalled. Routine executions own their timeout;
a bot's chat limit must not cancel a routine before its configured deadline. On an observed
incident, an external watchdog applied a 60-minute default to a 90-minute routine and
canceled it at 65.1 minutes. The cancellation endpoint returned HTTP 503 even though the
run became canceled, so that response cannot confirm or deny the final outcome.

`scripts/watchdog_policy.py` provides the policy for external Python watchdogs without
network access, credentials, server restarts or database writes. It is not installed by the
application. For the existing external Python watchdog, install the policy beside its script and
apply `docs/runbooks/watchdog.patch`. The patch replaces its age-only running-run selection
and stops claiming confirmation on HTTP failure. Other callers can integrate it as follows:

```python
from watchdog_policy import cancel_overdue_run, get_overdue_runs

for candidate in get_overdue_runs(connection, now_ms, bot_limits, default_limit=60):
    outcome = cancel_overdue_run(candidate, cancel_by_id)
    if outcome["cancellation_confirmed"]:
        report_confirmed_cancellation(outcome)
    else:
        report_unconfirmed_cancellation(outcome)
```

Use a read-only SQLite connection. `cancel_by_id` must use the existing authenticated
cancellation API, return its decoded response and raise on failure. Confirmation requires
`{"run": {"id": "<requested run ID>", "status": "canceled"}}`; HTTP success alone does not
prove cancellation if the run finished before the request. Missing, malformed or mismatched
run state remains unconfirmed. Do not report an unconfirmed outcome as canceled;
reconcile it with a later read of run status. Missing routine metadata skips automatic
cancellation instead of silently using a shorter chat deadline. Keep diagnostic alerts
for missing metadata separate from cancellation decisions.

The routine execution's original start is retained across resumed provider runs. Channel coordinators and delegated members without routine metadata are left to the
application runtime, which owns their finite deadlines and host overrides. A 62-minute
channel run must not inherit the generic 60-minute direct-chat limit. Channel routines
still use their absolute routine deadline. Direct one-to-one
chat runs retain caller-supplied per-bot limits and the default. No production watchdog is
changed by checking out or merging this policy; deployment is an explicit operator action.

Regression coverage uses only in-memory synthetic SQLite rows. Run
`bun test sidecar/test/runtime/watchdog-policy.test.ts` (Python 3.8+ required).
