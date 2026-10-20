import { render, within } from "@testing-library/react"
import type { Message } from "@touri/contracts"
import { describe, expect, it } from "vitest"
import { VirtualMessageList } from "../src/components/ChatPanel"

const getMessage = (id: string, sender: NonNullable<Message["sender"]>): Message => ({
  id,
  threadId: "shared-thread",
  parentId: null,
  role: "user",
  kind: "text",
  status: "complete",
  runId: null,
  text: `Mensagem de ${sender.name}`,
  parts: [{ type: "text", text: `Mensagem de ${sender.name}` }],
  sender,
  source: "local",
  createdAt: 1,
  updatedAt: 1,
})

describe("message senders", () => {
  it("shows another person's name, avatar and incoming alignment beside the current person's own message", () => {
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

    expect(within(ownMessage).getByText("Você")).toBeVisible()
    expect(ownMessage).toHaveClass("message-user")
    expect(ownMessage).not.toHaveClass("message-other-person")
    expect(within(otherMessage).getByText("Ana")).toBeVisible()
    expect(otherMessage).toHaveClass("message-other-person")
    expect(otherMessage.querySelector('[data-bot-id="ana"]')).not.toBeNull()
  })
})
