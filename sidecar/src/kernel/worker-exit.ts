import { deferWorkerReply } from "./worker-reply"

/** Register at creation: terminate() requests shutdown but does not wait for SQLite to close. */
export const getWorkerExit = (worker: Worker): Promise<void> =>
  new Promise((resolve) => worker.addEventListener("close", () => deferWorkerReply(resolve), { once: true }))
