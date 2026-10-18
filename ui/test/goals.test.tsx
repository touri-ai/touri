import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Message } from "@touri/contracts"
import { expect, test, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { ChatPanel } from "../src/components/ChatPanel"
import { GoalPanel } from "../src/components/GoalPanel"
import { localizeToolText, t } from "../src/i18n"

const makeFixture = (hasProject = true) => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  const request = api.getState().messages.find((message) => message.role === "user")
  if (!bot || !request) throw new Error("Missing mock conversation")

  render(
    <GoalPanel
      api={api}
      threadId={request.threadId}
      bot={{ ...bot, projectId: hasProject ? bot.projectId : null }}
      request={request}
      busy={false}
    />,
  )

  return { api, request }
}

const startGoal = async () => {
  fireEvent.click(screen.getByText("Avançado · Continuar até concluir"))
  fireEvent.change(screen.getByRole("textbox", { name: "O que precisa estar pronto para concluir?" }), {
    target: { value: "Tabela com três opções e fontes verificadas." },
  })
  const start = screen.getByRole("button", { name: "Continuar até concluir" })
  await waitFor(() => expect(start).toBeEnabled())

  fireEvent.click(start)
  await screen.findByRole("button", { name: "Pausar" })
}

test("an explicit criterion and bounded budget create a goal with visible controls", async () => {
  const { api, request } = makeFixture()

  await startGoal()

  expect(api.calls).toContainEqual(
    expect.objectContaining({
      route: "POST /threads/:id/goal",
      input: {
        requestMessageId: request.id,
        completionCriterion: "Tabela com três opções e fontes verificadas.",
        maxTurns: 4,
        maxMinutes: 15,
      },
    }),
  )
  expect(screen.getByRole("status")).toHaveTextContent("Em andamento")
  expect(screen.getByText("3 turnos seguintes · 15 min restantes")).toBeVisible()
  expect(screen.getByRole("button", { name: "Concluir agora" })).toBeEnabled()
})

test("pause, budget editing, resume and complete require explicit clicks", async () => {
  const { api } = makeFixture()
  await startGoal()

  fireEvent.click(screen.getByRole("button", { name: "Pausar" }))
  await screen.findByRole("button", { name: "Retomar" })
  fireEvent.click(screen.getByRole("button", { name: "Alterar orçamento" }))
  fireEvent.change(screen.getByRole("spinbutton", { name: "Limite de turnos" }), { target: { value: "6" } })
  fireEvent.click(screen.getByRole("button", { name: "Salvar orçamento" }))
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Pausado"))

  expect(api.calls.filter((call) => call.route === "PATCH /threads/:id/goal").map((call) => call.input)).toEqual([
    { action: "pause" },
    { action: "budget", maxTurns: 6, maxMinutes: 15 },
  ])

  fireEvent.click(screen.getByRole("button", { name: "Retomar" }))
  await screen.findByRole("button", { name: "Pausar" })
  fireEvent.click(screen.getByRole("button", { name: "Concluir agora" }))
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Concluído"))

  expect(screen.queryByRole("button", { name: "Retomar" })).toBeNull()
})

test("without an authorized folder the ordinary conversation limit is explained", async () => {
  makeFixture(false)

  fireEvent.click(screen.getByText("Avançado · Continuar até concluir"))

  expect(screen.getByText(/Vincule um projeto ou autorize uma pasta/)).toBeVisible()
  expect(screen.getByRole("button", { name: "Continuar até concluir" })).toBeDisabled()
})

test("saved checkpoints reappear when the conversation is reopened", async () => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  const request = api.getState().messages.find((message) => message.role === "user")
  if (!bot || !request) throw new Error("Missing mock conversation")
  const saved = await api.request(
    "POST /threads/:id/goal",
    {
      requestMessageId: request.id,
      completionCriterion: "Entrega revisada",
      maxTurns: 4,
      maxMinutes: 15,
    },
    { id: request.threadId },
  )
  await api.request("PATCH /threads/:id/goal", { action: "pause" }, { id: request.threadId })

  render(<GoalPanel api={api} threadId={request.threadId} bot={bot} request={request} busy={false} />)

  await screen.findByText(saved.goal.completionCriterion)
  expect(screen.getByRole("status")).toHaveTextContent("Pausado")
})

test("goal state and controls have English copy", () => {
  const labels = [
    "Continue until done",
    "Goal advanced",
    "Goal folder required",
    "Goal budget exhausted help",
    "Change goal budget",
  ] as const

  expect(labels.map((key) => t(key, {}, "en"))).toEqual([
    "Continue until done",
    "Advanced · Continue until done",
    "Link a project or authorize a folder to continue automatically. For now, the conversation continues one turn at a time.",
    "The limit was reached and the bot stopped. Change the budget and choose Resume to continue.",
    "Change budget",
  ])
})

test("goal checkpoint failures use plain language", () => {
  const failure = "ERROR NOT_FOUND: Não há um objetivo ativo para este turno."

  expect(localizeToolText(failure)).toBe("Não há um objetivo ativo para este turno.")
  expect(t(failure, {}, "en")).toBe("There is no active goal for this turn.")
})

test("a temporary checkpoint loading error clears after reconnecting", async () => {
  const base = createMockApi()
  const bot = base.getState().bots[0]
  const request = base.getState().messages.find((message) => message.role === "user")
  if (!bot || !request) throw new Error("Missing mock conversation")
  const api = { ...base, request: vi.fn(base.request).mockRejectedValueOnce(new Error("offline")) }

  render(<GoalPanel api={api} threadId={request.threadId} bot={bot} request={request} busy={false} />)
  await screen.findByRole("alert")
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull(), { timeout: 4000 })

  expect(api.request).toHaveBeenCalledTimes(2)
})

test("starting a goal uses the request on the visible branch", async () => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  const thread = api.getState().threads.find((candidate) => candidate.botId === bot?.id)
  const request = api.getState().messages.find((message) => message.threadId === thread?.id && message.role === "user")
  const reply = api
    .getState()
    .messages.find((message) => message.threadId === thread?.id && message.role === "assistant")
  if (!bot || !thread || !request || !reply) throw new Error("Missing mock conversation")
  const sibling: Message = {
    ...request,
    id: "other-branch-request",
    parentId: null,
    text: "Outro pedido em outra ramificação.",
    parts: [{ type: "text", text: "Outro pedido em outra ramificação." }],
  }

  render(
    <ChatPanel
      api={api}
      bot={bot}
      thread={{ ...thread, activeLeafId: reply.id }}
      messages={[request, { ...reply, parentId: request.id }, sibling]}
      runs={[]}
      onSend={vi.fn(async () => {})}
      onRetry={vi.fn(async () => {})}
      onCancel={vi.fn(async () => {})}
      onSwitchBranch={vi.fn(async () => {})}
      computerGrant={null}
      onComputerGrant={vi.fn()}
      onOpenTools={vi.fn()}
    />,
  )
  await startGoal()

  expect(api.calls).toContainEqual(
    expect.objectContaining({
      route: "POST /threads/:id/goal",
      input: expect.objectContaining({ requestMessageId: request.id }),
    }),
  )
})
