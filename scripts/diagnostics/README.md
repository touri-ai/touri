# Duplicate execution diagnostic

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
