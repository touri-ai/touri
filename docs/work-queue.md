# Work queue snapshots

`GET /runs` returns all queued, starting and running provider turns across bots.
Each run includes its origin (`message`, `routine`, `delegation`, or `resume`).
Group aggregate turns are excluded so a provider turn is counted once.

`queuePosition` is one-based in the engine waiting queue; `queueTotal` is the
number of waiting turns. Both are null for turns outside that queue. They are
optional for compatibility with older snapshots. These are computed fields,
not persisted columns: no database migration is required. The engine sends
`run.updated` for waiting turns whenever the queue changes. Thread snapshots
and the global work snapshot use the same engine projection.

The queue preserves submission order among turns eligible to start. A turn
whose conversation is already running waits until that conversation is free;
other conversations can use the available slots. Synchronous delegated work
can run outside the cap to avoid waiting behind its caller's occupied slot.

`runtime.settingsChanged` drains available slots after a successful settings
write. The engine reads the saved `maxConcurrentRuns` on each drain, including
after restart. A lower limit leaves existing turns running and delays the next
start until capacity is available; a higher limit starts waiting work immediately.
