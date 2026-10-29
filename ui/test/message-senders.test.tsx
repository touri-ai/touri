import { render, within } from "@testing-library/react"
import type { Message } from "@touri/contracts"
import { describe, expect, it } from "vitest"
import { VirtualMessageList } from "../src/components/ChatPanel"

const getMessage = (
  id: string,
  sender: NonNullable<Message["sender"]> | undefined,
  createdAt = 1,
  role: Message["role"] = "user",
): Message => ({
  id,
  threadId: "shared-thread",
  parentId: null,
  role,
  kind: "text",
  status: "complete",
  runId: null,
  text: `Mensagem de ${sender?.name ?? id}`,
  parts: [{ type: "text", text: `Mensagem de ${sender?.name ?? id}` }],
  ...(sender ? { sender } : {}),
  source: "local",
  createdAt,
  updatedAt: createdAt,
})

const renderMessages = (messages: Message[]) =>
  render(
    <VirtualMessageList
      messages={messages}
      currentPersonId="owner"
      onSwitchBranch={() => undefined}
      onRetry={async () => undefined}
    />,
  )

const getRow = (container: HTMLElement, id: string): HTMLElement => {
  const row = container.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
  if (!row) throw new Error(`Missing message ${id}`)

  return row
}

const owner = { id: "owner", name: "Pessoa A", avatarSeed: "owner-avatar", kind: "person" as const }
const lia = { id: "lia", name: "Lia", kind: "bot" as const }

describe("message senders", () => {
  it("shows an integration beside its avatar like a bot, with its label", () => {
    const sender = {
      id: "integration:notice",
      name: "touri avisos",
      avatarSeed: "notice-avatar",
      kind: "integration" as const,
    }

    const { container } = render(
      <VirtualMessageList
        messages={[getMessage("notice", sender)]}
        currentPersonId="owner"
        onSwitchBranch={() => undefined}
        onRetry={async () => undefined}
      />,
    )
    const notice = container.querySelector('[data-message-id="notice"]')
    if (!notice) throw new Error("Missing integration message")

    expect(within(notice).getByText("touri avisos")).toBeVisible()
    expect(within(notice).getByText("Integração")).toBeVisible()
    expect(within(notice).queryByText("Você")).toBeNull()
    expect(notice).toHaveClass("message-other-person")
    expect(notice).toHaveAttribute("data-message-author", "bot")
    expect(notice.querySelector('.message-avatar [data-bot-id="integration:notice"]')).not.toBeNull()
  })
  it("shows another person's name on an end-aligned tinted bubble beside the current person's own message", () => {
    const messages = [
      getMessage("owner-message", { id: "owner", name: "Pessoa A", avatarSeed: "owner-avatar", kind: "person" }),
      getMessage("ana-message", { id: "ana", name: "Ana", avatarSeed: "ana-avatar", kind: "person" }),
    ]

    const { container } = render(
      <VirtualMessageList
        messages={messages}
        currentPersonId="owner"
        onSwitchBranch={() => undefined}
        onRetry={async () => undefined}
      />,
    )

    const ownMessage = container.querySelector('[data-message-id="owner-message"]')
    const otherMessage = container.querySelector('[data-message-id="ana-message"]')
    if (!ownMessage || !otherMessage) throw new Error("Missing rendered messages")

    expect(ownMessage).toHaveClass("message-user")
    expect(ownMessage).not.toHaveClass("message-other-person")
    expect(ownMessage).toHaveAttribute("data-message-author", "own")
    expect(within(otherMessage).getByText("Ana")).toHaveClass("message-role")
    expect(otherMessage).toHaveClass("message-other-person")
    expect(otherMessage).toHaveAttribute("data-message-author", "person")
    expect(otherMessage.getAttribute("style")).toContain("--avatar-author-color")
    expect(otherMessage.querySelector(".tb-avatar")).toBeNull()
  })

  it("draws your own message as a bare bubble with the time in the action row", () => {
    const { container } = renderMessages([getMessage("own", owner)])
    const own = getRow(container, "own")

    expect(own).toHaveAttribute("data-message-author", "own")
    expect(own.querySelector(".tb-avatar, .message-meta, .message-role, .message-avatar")).toBeNull()
    expect(own.querySelector(".message-body")).toHaveTextContent("Mensagem de Pessoa A")
    expect(own.querySelector(".message-actions time")).not.toBeNull()
    expect(within(own).getByText("Você")).toHaveClass("visually-hidden")
  })

  it("draws a bot beside its avatar with its name above a text bubble", () => {
    const { container } = renderMessages([getMessage("bot", lia, 1, "assistant")])
    const bot = getRow(container, "bot")

    expect(bot).toHaveAttribute("data-message-author", "bot")
    expect(bot.querySelector(".message-avatar .tb-avatar")).not.toBeNull()
    expect(bot.querySelector(".message-meta .message-role")).toHaveTextContent("Lia")
    expect(bot.querySelector(".message-meta time")).not.toBeNull()
    expect(bot.querySelector(".message-body .message-text")).toHaveTextContent("Mensagem de Lia")
  })

  it("keeps the avatar gutter but drops avatar and name on a continuation of the same author", () => {
    const start = Date.UTC(2026, 9, 1, 12)
    const { container } = renderMessages([
      getMessage("first", lia, start, "assistant"),
      getMessage("second", lia, start + 60_000, "assistant"),
    ])
    const second = getRow(container, "second")

    expect(getRow(container, "first")).not.toHaveAttribute("data-message-grouped")
    expect(second).toHaveAttribute("data-message-grouped", "true")
    expect(second.querySelector(".message-avatar")).toBeEmptyDOMElement()
    expect(second.querySelector(".message-meta")).toBeNull()
    expect(second.querySelector(".message-actions time")).not.toBeNull()
  })

  it("groups only consecutive messages by the same author within five minutes and the same day", () => {
    const start = Date.UTC(2026, 9, 1, 12)
    const other = { id: "ana", name: "Ana", avatarSeed: "ana-avatar", kind: "person" as const }
    const { container } = renderMessages([
      getMessage("first", owner, start),
      getMessage("at-five-minutes", owner, start + 5 * 60_000),
      getMessage("after-five-minutes", owner, start + 10 * 60_000 + 1),
      getMessage("other-author", other, start + 10 * 60_000 + 2),
      getMessage("owner-after-other", owner, start + 10 * 60_000 + 3),
      getMessage("bot-after-owner", lia, start + 10 * 60_000 + 4, "assistant"),
      getMessage("system", undefined, start + 11 * 60_000, "system"),
      getMessage("bot-after-system", lia, start + 11 * 60_000 + 1, "assistant"),
      getMessage("before-day", owner, Date.UTC(2026, 9, 1, 23, 58)),
      getMessage("after-day", owner, Date.UTC(2026, 9, 2, 0, 2)),
    ])
    const isGrouped = (id: string) => getRow(container, id).hasAttribute("data-message-grouped")

    expect(isGrouped("at-five-minutes")).toBe(true)
    expect(isGrouped("after-five-minutes")).toBe(false)
    expect(isGrouped("other-author")).toBe(false)
    expect(isGrouped("owner-after-other")).toBe(false)
    expect(isGrouped("bot-after-owner")).toBe(false)
    expect(isGrouped("bot-after-system")).toBe(false)
    expect(isGrouped("after-day")).toBe(false)
  })
})
