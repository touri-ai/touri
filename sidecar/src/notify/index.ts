import type { Database } from "bun:sqlite"
import type { Kernel, NotifyKind } from "@touri/contracts"
import { createNotifier } from "./notifier"
import { createNotifyRoutes } from "./routes"
import { createSseHub } from "./sse"
import { createNotificationStore } from "./store"

export const name = "notify"

const RESOLVED_BY_USER_REPLY: ReadonlyArray<NotifyKind> = ["question", "turn-failed", "routine-failed"]
const RESOLVED_BY_NEW_RUN: ReadonlyArray<NotifyKind> = ["turn-failed", "routine-failed", "routine-deferred"]

export const init = async (kernel: Kernel): Promise<void> => {
  const store = createNotificationStore({ db: kernel.db as Database })
  const hub = createSseHub({ store })
  const notifier = createNotifier({ kernel, store, hub })

  kernel.services.provide("notify.emit", notifier.emit)
  kernel.services.provide("notify.resolve", ({ requestId, resolution }) => {
    notifier.resolveRequest({ requestId, resolution })
  })

  kernel.subscribe(({ event }) => {
    if (event.type === "run.updated" && ["queued", "starting", "running"].includes(event.run.status)) {
      const { run } = event
      const threadId =
        kernel.services.use("store.api")?.getThread({ threadId: run.threadId })?.groupThreadId ?? run.threadId
      for (const item of store.unresolvedForThread({ threadId, kinds: RESOLVED_BY_NEW_RUN }))
        if (item.botId === run.botId && item.createdAt <= (run.startedAt ?? run.queuedAt))
          notifier.finish({ id: item.id, resolution: "expired" })
    }
    if (event.type !== "message.created" || event.message.role !== "user") return
    for (const item of store.unresolvedForThread({ threadId: event.message.threadId, kinds: RESOLVED_BY_USER_REPLY }))
      notifier.finish({ id: item.id, resolution: "replied" })
  })

  kernel.registerRoutes(createNotifyRoutes({ kernel, store, notifier, hub }))
}
