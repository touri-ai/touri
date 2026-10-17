import type { ProviderEvent } from "@touri/contracts"
import { createStreamingRedactor, redactStructured } from "../kernel/redact"

// Retain a possible credential prefix between deltas so splitting a token across frames cannot leak it.
export const redactVmEvents = ({
  secrets,
  redact,
  emit,
}: {
  secrets: Array<string>
  redact: (text: string) => string
  emit: (event: ProviderEvent) => void
}) => {
  const pending = new Map<
    string,
    { type: "text_delta" | "reasoning_delta"; itemId: string; stream: ReturnType<typeof createStreamingRedactor> }
  >()
  const flush = () => {
    for (const value of pending.values()) {
      const delta = value.stream.flush()
      if (delta) emit({ type: value.type, itemId: value.itemId, delta })
    }
    pending.clear()
  }
  const handle = (event: ProviderEvent) => {
    if (event.type === "text_delta" || event.type === "reasoning_delta") {
      const key = `${event.type}:${event.itemId}`
      if (!pending.has(key)) flush()
      let value = pending.get(key)
      if (!value) {
        value = { type: event.type, itemId: event.itemId, stream: createStreamingRedactor(redact, secrets) }
        pending.set(key, value)
      }
      const delta = value.stream.push(event.delta)
      if (delta) emit({ ...event, delta })
      return
    }
    // Preserve semantic boundaries even when a credential prefix is still buffered.
    if (event.type === "item" || event.type === "approval_request") flush()
    if (event.type === "turn_completed") {
      flush()
      emit({ ...event, errorMessage: event.errorMessage === null ? null : redact(event.errorMessage) })
    } else if (event.type === "approval_request") {
      // Routing IDs and discriminants are protocol state, separate from the
      // provider's display text. Runtime assigns its own ID to the visible card.
      emit({ ...event, part: { ...event.part, detail: redact(event.part.detail) } })
    } else if (event.type === "item") {
      const part = redactStructured(event.part, redact) as typeof event.part
      emit({
        ...event,
        part: Object.assign(part, {
          type: event.part.type,
          ...("callId" in event.part ? { callId: event.part.callId } : {}),
        }),
      })
    } else emit(event)
  }
  return Object.assign(handle, { flush })
}
