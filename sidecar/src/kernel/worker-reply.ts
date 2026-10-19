/** Bun can deadlock a nested promise wait inside a worker inbox continuation (oven-sh/bun#37189). */
export const deferWorkerReply = (complete: () => void): void => {
  setImmediate(complete)
}
