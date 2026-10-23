import type { Message } from "@touri/contracts"

const isCancelNotice = (part: Message["parts"][number]): boolean =>
  part.type === "notice" && part.code === "run_canceled"

/** A reply with nothing but the cancel notice adds no content of its own. */
const isEmptyCancelReply = (message: Message): boolean =>
  message.role === "assistant" &&
  message.status === "canceled" &&
  message.text.trim() === "" &&
  message.parts.length > 0 &&
  message.parts.every(isCancelNotice)

const isSameAuthor = (reply: Message, echo: Message): boolean =>
  echo.sender === null || reply.sender?.id === echo.sender.id

/**
 * Stopping a channel task cancels its coordination and its member execution. The coordination may
 * leave a reply with only the cancel notice next to the execution reply that holds the text and
 * actions; showing both reads as two stopped tasks. Only that empty echo is hidden; the stored
 * transcript, failures and replies with content stay visible.
 */
export const getChannelMessages = (messages: readonly Message[]): Message[] =>
  messages.filter((message, index) => {
    if (!isEmptyCancelReply(message)) return true
    const earlier = messages.slice(0, index)
    const requestIndex = earlier.map((item) => item.role).lastIndexOf("user")
    const sameRequest = earlier.slice(requestIndex + 1)

    return !sameRequest.some(
      (reply) =>
        reply.role === "assistant" &&
        reply.status === "canceled" &&
        !isEmptyCancelReply(reply) &&
        isSameAuthor(reply, message),
    )
  })
