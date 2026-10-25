import type { Message } from "@touri/contracts"

type Candidate = Pick<Message, "id" | "threadId" | "parts">

export const getHistoryAttachmentMessageIds = async (
  threadId: string,
  messages: Candidate[],
  signal: AbortSignal,
): Promise<string[]> => {
  let candidates: string[] = []
  for (let offset = 0; offset < messages.length; offset += 32) {
    signal.throwIfAborted()
    const batch = messages
      .slice(offset, offset + 32)
      .filter((message) => message.threadId === threadId && hasAttachments(message))
      .map(({ id }) => id)
    candidates = candidates.concat(batch)
    if (offset + 32 < messages.length) await new Promise<void>((resolve) => setImmediate(resolve))
  }
  signal.throwIfAborted()

  return candidates
}

const hasAttachments = (message: Candidate): boolean =>
  message.parts.some(
    (part) =>
      part.type === "image" ||
      part.type === "file" ||
      ("outputAttachmentId" in part && typeof part.outputAttachmentId === "string"),
  )
