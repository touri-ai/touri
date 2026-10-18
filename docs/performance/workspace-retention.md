# Workspace retention

The open conversation keeps its complete transcript and run history. Other conversations keep
compact sidebar summaries: at most five recent message slots per thread, plus outstanding
approvals, pending deliveries and active streams. Completed background runs keep their latest
row; active runs remain available regardless of which conversation is open.

Eviction changes only client memory. Messages, branches, failed and canceled turns and tool
results remain durable on the server. Opening a conversation requests its full history again,
including pending sends from the durable client journal. Leaving a conversation discards its
pending replay buffer. A selected history request buffers at most 256 KiB of serialized stream
events, estimated as UTF-16; overflow triggers a fresh snapshot.

Retention is checked when conversations switch or background collections change. Streaming
updates in the open conversation reuse unchanged background summaries and run collections.
Pruning runs only when a collection exceeds its retention slots or outstanding work changes.
Messages and arrays retain their identity whenever their contents already meet the limits.

## Reproducible workload

The synthetic fixture creates 30 bots, opens bot 0, and delivers 40 turns from each of the other
29 bots. Each turn includes prose, reasoning, a tool result, run state and unread metadata.
Histories are reconstructed on request so the fixture does not retain the payloads being measured.

- `ui/test/workspace-retention.test.tsx` requires retained workspace state below 1 MiB after each
  wave and after visiting every bot. It covers history restoration, pending requests, active
  streams, delayed responses, group sender identity and identity preservation during streaming.
- `ui/test/e2e/workspace-retention.spec.ts` drives the app with mock data, collects browser garbage
  before sampling heap, and limits growth above the loaded-app baseline to 8 MiB. Reopening an
  evicted conversation must request and restore its complete history.

These budgets measure serialized client state and browser heap. They do not establish native
process RSS, transport memory, or the cost of a large open transcript. Outstanding work, routine
history and native allocations remain outside the fixed background-transcript budget.

## Native verification

The 150 MB total idle RSS target requires measurement on macOS. Use a disposable desktop paired
to a 30-bot test server, finish one visible reply, deliver background events, and sample the shell
and its associated services every 30 seconds. Use the same workload and build settings before
and after. Include WebContent, Networking and GPU services in the total.
