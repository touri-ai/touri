import type { Run, UiEvent } from "@touri/contracts"

const key = "touri.response-timings.v1"
type Sample = {
  threadId: string
  nonce: string
  requestId?: string
  runId?: string
  sent: number
  accepted?: number
  provider?: number
  firstEvent?: number
  firstText?: number
}

/** Bounded, device-local timings. Never stores prompts, output, reasoning or credentials. */
export const createResponseTimings = (storage: Pick<Storage, "getItem" | "setItem">, now = Date.now) => {
  let samples: Sample[] = []
  try {
    const saved: unknown = JSON.parse(storage.getItem(key) ?? "[]")
    if (Array.isArray(saved)) samples = saved.filter((row) => typeof row?.sent === "number").slice(0, 10)
  } catch {
    // Storage is optional; measurements must never prevent a send.
  }
  const pending = new Map<string, Run>()
  const save = () => {
    try {
      storage.setItem(key, JSON.stringify(samples))
    } catch {
      // Private browsing or a full disk must not affect the conversation.
    }
  }
  const accept = (sample: Sample, run: Run) => {
    if (sample.runId && sample.runId !== run.id) return
    sample.runId = run.id
    sample.accepted ??= now()
    if (run.providerStartedAt != null) sample.provider ??= now()
    if (run.status === "running") sample.firstEvent ??= now()
  }
  return {
    begin: (threadId: string, nonce: string) => {
      if (samples.length >= 10 || samples.some((row) => row.threadId === threadId)) return
      samples.push({ threadId, nonce, sent: now() })
      save()
    },
    observe: (event: UiEvent) => {
      const before = JSON.stringify(samples)
      if (event.type === "run.updated") {
        const sample = samples.find((row) => row.runId === event.run.id || row.requestId === event.run.requestMessageId)
        if (sample) accept(sample, event.run)
        else if (event.run.requestMessageId) {
          pending.set(event.run.requestMessageId, event.run)
          if (pending.size > 20) pending.delete(pending.keys().next().value ?? "")
        }
      }
      if (event.type === "message.created" || event.type === "message.updated") {
        const message = event.message
        const sent = samples.find((row) => row.nonce === message.delivery?.clientNonce)
        // The local journal already has the stable request identity before acknowledgement.
        if (sent && message.role === "user") {
          sent.requestId = message.id
          const run = pending.get(message.id)
          if (run) accept(sent, run)
        }
        const sample = samples.find((row) => row.runId === message.runId)
        if (sample && message.role === "assistant" && message.parts.length) {
          sample.firstEvent ??= now()
          if (message.text.trim() || message.parts.some((part) => part.type === "text" && part.text.trim()))
            sample.firstText ??= now()
        }
      }
      if (event.type === "message.delta" && event.delta.trim()) {
        const sample = samples.find((row) => row.threadId === event.threadId && row.accepted !== undefined)
        if (sample) {
          sample.firstEvent ??= now()
          if (event.partType === "text") sample.firstText ??= now()
        }
      }
      if (before !== JSON.stringify(samples)) save()
    },
    read: () =>
      samples.map((row, index) => ({
        conversation: index + 1,
        sendToAcceptMs: row.accepted === undefined ? null : row.accepted - row.sent,
        acceptToFirstEventMs:
          row.firstEvent === undefined || row.accepted === undefined ? null : row.firstEvent - row.accepted,
        sendToFirstTextMs: row.firstText === undefined ? null : row.firstText - row.sent,
        providerToFirstEventMs:
          row.firstEvent === undefined || row.provider === undefined ? null : row.firstEvent - row.provider,
      })),
  }
}

let local: ReturnType<typeof createResponseTimings> | undefined
export const localResponseTimings = () => {
  local ??= createResponseTimings({
    getItem: (name) => localStorage.getItem(name),
    setItem: (name, value) => localStorage.setItem(name, value),
  })
  return local
}
