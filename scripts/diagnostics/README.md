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

A channel coordinator waits for an active coordinator in its **group** when their
recipients overlap, even when the coordinators have different `bot_id` values or
conversations. Independent recipients can run concurrently. Live delegated member
runs also reserve their bot for the owning coordinator. The query checks declared
recipients and persisted live delegations; it returns the coordinator, never its
provider child. Ordinary executions serialize per **thread**, so another thread
using the same bot is not a blocker. Their `wait_scope` is `thread`.

`blocker_run_id = NULL` means no direct active blocker was established in this
snapshot; it is not proof of a deadlock. Ordering behind an earlier waiting
request, the global execution limit, and delegation reservations before a member
run is persisted cannot be attributed by this query. Multiple active blockers
may exist; it returns the earliest started matching one, with run ID as a tie
breaker. Starting/running state does not prove provider progress.

Consumers should report `wait_scope` and `blocker_run_id` rather than diagnosing
all delayed coordinators as a stalled bot. Do not automatically cancel or restart
work based on this query. It returns identifiers and timestamps, never messages.

### Blocking work progress

Waiting age alone does not distinguish a healthy long task from a stuck execution.
The query also returns `blocker_started_at` and `blocker_last_progress_at` in Unix
milliseconds, preserving the existing cutoff parameter and blocker selection.
A missing blocker leaves both timestamps null; missing reply progress stays null
rather than falling back to the coordinator's start time.

For channel waits, progress is the maximum `messages.updated_at` of replies owned
by the blocker's starting/running member executions for the waiting recipients,
including delegated executions. Finished attempts and unrelated recipients do not
contribute. For thread waits, only the blocking execution's own reply contributes.
Reply lookup requires the message ID, execution thread and run ID together.
The query never reads reply text or parts, event history, credentials or paths.

Consumers should include these timestamps in delayed-request reports and compare
progress against their observation time before claiming an execution has stalled.
Recent reply updates are evidence of output persistence, not proof that every
recipient is healthy or that a process is alive. Stale or missing timestamps are
unknown progress, not permission to cancel, restart or replay work; use runtime
supervision and explicit user controls for that. Updating this file does not
install a new query in an external watchdog: that consumer must adopt it.
