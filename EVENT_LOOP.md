# Event loop

Every contributor and reviewer, human or agent, reads this before writing or reviewing code.
The central rule is **never block the event loop** in the Bun sidecar, the `touri serve` server,
or the UI. One slow callback delays unrelated requests, turns, streaming, cancellation and input.
Read [STYLE.md](STYLE.md) and [SECURITY_REVIEW.md](SECURITY_REVIEW.md) alongside this guide.

## 1. Keep live paths asynchronous and bounded

Request handlers, agent turns, streaming callbacks, timers and UI handlers are live paths.
The rule also applies to helpers they call and work scheduled after a response.

| Do not run on a live event loop | Use instead |
| --- | --- |
| `spawnSync`, `execSync`, `execFileSync`, `Bun.spawnSync` | `Bun.spawn`, asynchronous child-process APIs or `kernel.spawnTree`; drain output concurrently and await exit |
| `readFileSync`, `writeFileSync`, `statSync`, `existsSync`, `readdirSync`, `realpathSync` and other synchronous filesystem calls | `node:fs/promises`, asynchronous `Bun.file`/`Bun.write` operations, streams and bounded directory iteration |
| Long synchronous loops, sorting or traversing unbounded collections | Bounded batches with a time/size budget and a real yield between batches; workers for CPU-heavy work |
| `JSON.parse`/`JSON.stringify` over large payloads or an entire growing transcript per token | Size limits, pagination, incremental parsing/serialization or a worker |
| Regexes with catastrophic backtracking over untrusted input | Bounded input and a parser or expression with predictable runtime |
| Large synchronous hashing, encryption or compression | Asynchronous APIs that offload the work, streaming transforms or a worker |
| Walking whole directory trees or loading every entry before filtering | Asynchronous iteration with entry, depth, result and elapsed-time limits; stop on cancellation |

An `async` declaration, `Promise.resolve()` or a timer does not make synchronous work nonblocking.
Use `queueMicrotask` only for small, bounded coalescing or ordering work: microtasks drain before
I/O and rendering, so recursively queuing them can starve the loop. Slice larger work with
`setImmediate` in the sidecar/server or another runtime-appropriate task yield. A worker is needed
when even one unit of CPU work exceeds the budget; yielding cannot interrupt that unit.

Real repository examples:

- [kernel/ps.ts](sidecar/src/kernel/ps.ts) runs `ps` through `Bun.spawn`, reads stdout while waiting
  for exit, and kills the child on timeout. The comment records the incident behind
  [#121](https://github.com/touri-ai/touri/issues/121) and the fix in
  [#157](https://github.com/touri-ai/touri/pull/157): `Bun.spawnSync` inside an HTTP turn-start
  handler let Bun 1.2 re-enter HTTP/WebSocket callbacks, producing stray 400 responses and a
  segfault in `AsyncSocket::uncork`. Never reintroduce synchronous spawning in the live sidecar.
- [projects/discovery.ts](sidecar/src/projects/discovery.ts) uses `opendir` and promise-based
  filesystem calls, skips heavy/hidden directories and directory symlinks, and limits discovery
  to four levels, 20,000 entries, 50 results and a two-second deadline. Preserve these bounds.
- [cli/web/compression.ts](sidecar/src/cli/web/compression.ts) is a review hotspot: its async
  response helper still reaches synchronous Brotli/gzip compression. An async wrapper is not
  evidence that large responses are safe; bound, offload or stream such work when changing it.

Existing synchronous calls are not permission to add more. Apply these rules to code you touch;
identify pre-existing problems separately instead of claiming the whole repository already complies.

## 2. Treat SQLite as synchronous work

`bun:sqlite` runs queries and transactions synchronously on the calling thread. `await` around a
query does not offload it. WAL improves reader/writer concurrency; it does not make SQL asynchronous.

- Keep live queries short and indexed. Use `EXPLAIN QUERY PLAN` against representative synthetic
  data, bounded `LIMIT`s and pagination, preferably indexed cursor/keyset seeks. A `LIMIT` after
  an unindexed scan, sort, aggregation or JSON extraction does not bound the work before it.
- Never scan the event tables (`transcript_entries`, `ui_event_log`) in a request, including
  recovery, retention or notification helpers reached by the request. Use indexed candidates,
  checkpoints, maintained projections and bounded replay windows instead of parsing all history.
- Keep transactions small; never hold one across external I/O or `await`. Bound rows and bytes
  as well as elapsed time. A single slow query cannot be preempted by a JavaScript timer.
- Preserve WAL in [kernel/db.ts](sidecar/src/kernel/db.ts). Review lock contention and
  `busy_timeout`: the current five-second setting can itself stall the calling thread. Increasing
  it is not a latency fix. Do not run full `VACUUM`, bulk rewrites or large checkpoints in handlers.
- Move expensive imports, compaction, migrations and retention out of the request path. Use
  resumable, bounded batches that commit and yield; offload heavier SQL to a dedicated worker or
  process with explicit connection ownership and cancellation. A background timer on the same
  loop still blocks while its callback runs.

The operational incident to remember is a **743 MB database snapshot with APIs taking 25–56 seconds**.
The [related investigation (#204)](https://github.com/touri-ai/touri/issues/204) records 56 seconds
for bot metadata and 25 seconds for workspace activity on an earlier snapshot: accumulated
transcript snapshots and synchronous historical work stalled unrelated endpoints. A small HTTP
response is no protection against a large database operation behind it.

Follow the bounded-work patterns in [store/stream-writer.ts](sidecar/src/store/stream-writer.ts)
(100 ms / 8 KiB delta flush thresholds and periodic checkpoints),
[kernel/transcript-storage.ts](sidecar/src/kernel/transcript-storage.ts) (indexed retention
candidates and bounded deletion batches), and
[kernel/history-backfill.ts](sidecar/src/kernel/history-backfill.ts) (resumable batches with an
eight-millisecond processing budget). These are specific patterns, not a guarantee that every
query in those files is bounded. [hot-endpoints-perf.test.ts](sidecar/test/store/hot-endpoints-perf.test.ts)
exercises endpoints and query plans with 500,000 synthetic events.

## 3. Protect the UI frame budget

- Do not parse, format Markdown, highlight code, sort history or rebuild the full transcript for
  each streaming token. Process deltas incrementally and coalesce visible updates with
  `requestAnimationFrame`, at most one bounded batch per frame. Flush terminal state reliably
  and handle cancellation/unmount; background tabs may throttle animation frames.
- Keep long lists virtualized. [ChatPanel.tsx](ui/src/components/ChatPanel.tsx) already has
  `VirtualMessageList`; preserve bounded DOM work when changing history, cards or scrolling.
- Review the WebSocket parsing in [api/client.ts](ui/src/api/client.ts) and delta application in
  [useWorkspace.ts](ui/src/useWorkspace.ts) together. Bound individual frames and pending queues,
  parse framed input incrementally, and avoid repeatedly parsing or copying accumulated output.
  Move large indivisible parsing/CPU work to a Web Worker.
- Use `requestIdleCallback` for nonurgent, bounded work, with feature detection and a bounded
  timer fallback. Respect `deadline.timeRemaining()` and reschedule remaining work; an idle
  callback is not permission to run a large synchronous task.

## 4. Bound I/O, cancellation and concurrency

Every external I/O operation needs a finite timeout and an `AbortSignal`: network/MCP/provider
requests, subprocesses and external host calls. Combine the caller's cancellation with a deadline,
pass it through helpers, and stop the underlying operation on timeout, disconnect or turn cancel.
For APIs without signal support, explicitly close/kill the resource and remove timers/listeners.
A `Promise.race` that only rejects its caller leaves the expensive operation running.

[kernel/policy.ts](sidecar/src/kernel/policy.ts) provides `withDeadline`, passing a derived signal
to its operation. [projects/git.ts](sidecar/src/projects/git.ts) shows subprocess cleanup,
concurrent stdout/stderr/exit handling, and `Promise.all` for independent metadata queries.
Never `await` independent operations in series; use bounded concurrency with `Promise.all` or
`Promise.allSettled` as appropriate. Keep genuinely dependent work ordered and respect resource limits.

Preserve stream backpressure: await writes/drain, honor pull/demand or `desiredSize`, cap buffered
bytes and queue length, and cancel upstream when the consumer leaves. Do not eagerly buffer an
unbounded response or let a slow SSE/WebSocket client grow memory without limit; use bounded
replay/resync or disconnect policy. Drain subprocess stdout and stderr concurrently to avoid deadlock.

## 5. Measure and review

Use these review budgets under representative load: **sidecar/server event-loop lag p99 < 50 ms**
and **UI handlers/render work < 16 ms per frame**, with room left for layout and paint. These are
targets to verify, not claims about current performance; request duration includes time waiting
for external I/O and is a separate measurement.

[kernel/performance.ts](sidecar/src/kernel/performance.ts) samples timer drift every second and
exposes rolling `lagMs`, `p99Ms`, `maxMs` and `samples` through `/health`. It warns at 500 ms of
lag and two-second requests, with a cooldown; those warning thresholds are not acceptable latency
budgets. Use authorized access to health diagnostics. Coarse timer sampling can miss short stalls.

For focused measurements, use `monitorEventLoopDelay` from `node:perf_hooks` where the runtime
supports it (histogram values are nanoseconds; divide by 1,000,000 for milliseconds), or sample
expected versus actual `setTimeout` firing with a monotonic clock. Bound/reset samples and stop
the probe on teardown. Record p99/max, sample interval/window, runtime, data size and concurrency.
Use browser Performance traces and frame timings while typing, scrolling and streaming. Keep all
evidence synthetic and follow [SECURITY_REVIEW.md](SECURITY_REVIEW.md) when recording diagnostics.

Tests should assert responsiveness with a percentile across enough samples plus a generous absolute
guard for a severe stall, rather than failing on one worst sample. Measure CPU time for synchronous
work when wall time would mostly reflect runner scheduling. For tests that coordinate with background
work, hold the work at an explicit hook and release it from the test instead of sleeping for a guessed
duration; use a generous timeout only as a failure bound.

Before approving a PR:

- [ ] Trace live entry points and helpers for synchronous process/filesystem calls and unbounded CPU work.
- [ ] Check query plans, pagination, transaction size, lock waits and maintenance with large synthetic history.
- [ ] Verify bounded streaming buffers, concurrent independent I/O, deadlines and real upstream cancellation.
- [ ] Check frame batching, incremental parsing, virtualization and responsiveness during streaming.
- [ ] Attach relevant before/after lag, endpoint or UI measurements; explain NA for unaffected paths.
- [ ] Document any permitted synchronous exception and complete the security review.

## 6. Narrow exception: startup and one-shot CLI work

Bounded synchronous work may be acceptable during initialization before live callbacks can run,
or in a standalone, one-shot CLI command. Add a comment explaining why it cannot delay requests,
turns, timers or UI input, how its size is bounded, and why an async version is unsuitable.
Starting a server, invoking a CLI helper from a handler, or scheduling work later does not qualify.
Large startup migrations should still be resumable/offloaded so launch remains responsive.
