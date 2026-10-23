import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { createMockApi } from "../src/api/mock"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { GroupPanel } from "../src/components/GroupPanel"

afterEach(cleanup)

it("keeps a channel panel free of turn results and repeated bot details", async () => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Missing synthetic bot")
  const { group, thread } = await api.request("POST /groups", {
    name: "Mapas de demonstração",
    color: "#16a34a",
    avatarShape: "classic-none",
    memberIds: [bot.id],
    coordinatorBotId: bot.id,
  })

  render(
    <GroupPanel
      group={group}
      bots={[{ ...bot, roleLine: "Organiza os mapas" }]}
      threadId={thread.id}
      onClose={() => undefined}
      onEdit={() => undefined}
      channelMode
    />,
  )

  expect(screen.queryByText("Resultados do turno")).toBeNull()
  expect(screen.queryByText("Somente respostas finais confirmadas. Este quadro é apenas para leitura.")).toBeNull()
  expect(screen.queryByText("Organiza os mapas")).toBeNull()
  expect(screen.queryByText("Bot", { exact: true })).toBeNull()
  expect(screen.getByText("Disponível")).toBeVisible()
  expect(screen.getByRole("button", { name: "Editar canal" })).toBeVisible()
})

it("hides delivery confirmation after acknowledgement while retaining the message", () => {
  const base = createMockApi().getState().messages[0]
  if (!base) throw new Error("Missing synthetic message")
  const message = {
    ...base,
    role: "user" as const,
    text: "Mensagem de demonstração",
    parts: [{ type: "text" as const, text: "Mensagem de demonstração" }],
    delivery: { status: "acked" as const, clientNonce: "demo", deadline: 60_000 },
  }

  render(<VirtualMessageList messages={[message]} onSwitchBranch={() => undefined} onRetry={async () => undefined} />)

  expect(screen.getByText("Mensagem de demonstração")).toBeVisible()
  expect(screen.queryByText("Entregue", { exact: true })).toBeNull()
  expect(document.querySelector(".delivery-state")).toBeNull()
})
