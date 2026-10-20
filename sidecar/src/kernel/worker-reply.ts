/**
 * Bun can deadlock a nested promise wait inside a worker inbox continuation (oven-sh/bun#37189).
 * Settle replies from a timer: promise reactions queued from a setImmediate callback here can wait
 * for an unrelated event-loop wakeup, which stalled every file I/O reply by up to a test timeout.
 */
export const deferWorkerReply = (complete: () => void): void => {
  setTimeout(complete, 0)
}
