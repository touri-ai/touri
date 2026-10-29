# Offline diagnostics

## Duplicate execution

`duplicate-runs.sql` is a read-only query for standalone watchdogs inspecting a
local touri SQLite database. Bind one parameter: the observation window's start
in epoch milliseconds. It returns bot ID and two execution IDs, without message
text, environments or credentials. Open the database in read-only mode.

A channel send creates a coordination run in the channel thread and member
executions in participant threads. `group_turns.run_id` identifies the former;
`group_run_links` links the latter to the channel turn. A coordinator and its
member can start within one second and share a bot ID without launching two
providers. Never infer execution from `runs.bot_id` and timing alone, or exclude
all linked runs: linked member runs are real executions.

This query keeps the existing cross-thread, sub-second heuristic but requires
the same non-null request message or channel turn and excludes coordinators.
Separate messages to the same bot are not duplicate deliveries. Later retries,
same-thread duplicates and duplicates with missing causal identity are outside
this diagnostic's scope. It does not cancel runs or change dispatch behavior.

Run only in a standalone maintenance process, not an HTTP handler, timer on the
sidecar event loop or provider callback. The observation predicate is not an
indexed history bound; use an external process deadline for large databases.
The host watchdog must adopt this query; updating the app alone does not change
an external watchdog's SQL.

## Queued runs

`queued-runs.sql` accepts one cutoff in Unix milliseconds. Open SQLite read-only
and run this query in a separate maintenance process with an external deadline.
The historical scan is not suitable for sidecar request handlers or callbacks.

A channel coordinator waits behind the active coordinator of its **group**, even
when that coordinator belongs to another bot or conversation. An ordinary bot run
waits behind an active provider run of that bot, excluding channel coordinators.
`blocker_run_id = NULL` means no active blocker was found in this snapshot; it is
not proof of a deadlock. Starting/running state does not prove provider progress.

Consumers should report `wait_scope` and `blocker_run_id` rather than diagnosing
all delayed coordinators as a stalled bot. Do not automatically cancel or restart
work based on this query. It returns identifiers and timestamps, never messages.
