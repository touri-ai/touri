import { redactToolText } from "@touri/contracts/redaction"
import { createStreamingRedactor, redactionValues } from "../kernel/redact"

export const COMMAND_OUTPUT_BYTES = 16 * 1024
export const COMMAND_OUTPUT_INTERVAL_MS = 250

export const commandOutputTail = (text: string, maxBytes = COMMAND_OUTPUT_BYTES): string => {
  if (Buffer.byteLength(text) <= maxBytes) return text
  const bytes = Buffer.from(text)
  let start = bytes.length - maxBytes
  while ((bytes[start] ?? 0) >> 6 === 2) start += 1
  return bytes.subarray(start).toString("utf8")
}

export const createCommandOutput = (redact: (text: string) => string) => {
  const secrets: string[] = []
  const stream = createStreamingRedactor((text) => text, secrets)
  let tail = ""
  const append = (text: string): string => {
    const combined = tail + text
    const safe = commandOutputTail(redactToolText(combined, redact))
    // Keep bounded context before the visible tail for credentials split across frames.
    tail = commandOutputTail(combined, COMMAND_OUTPUT_BYTES * 2)
    return safe
  }
  return {
    append: (delta: string): string => {
      secrets.splice(0, secrets.length, ...redactionValues(redact))
      return append(stream.push(delta))
    },
    flush: (): string => append(stream.flush()),
  }
}
