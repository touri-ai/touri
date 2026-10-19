import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { Message } from "@touri/contracts"
import { afterEach, expect, test, vi } from "vitest"
import App, { getGoalSelection } from "../src/App"
import { createMockApi } from "../src/api/mock"
import { GoalPanel } from "../src/components/GoalPanel"
import { localizeToolText, t } from "../src/i18n"

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const makeFixture = (hasProject = true, api = createMockApi()) => {
  const bot = api.getState().bots[0]
  const request = api.getState().messages.find((message) => message.role === "user")
  if (!bot || !request) throw new Error("Missing mock conversation")

  const view = render(
    <GoalPanel
      api={api}
      threadId={request.threadId}
      bot={{ ...bot, projectId: hasProject ? bot.projectId : null }}
      request={request}
      busy={false}
    />,
  )

  return { api, request, ...view }
}

const startGoal = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Definir objetivo" }))
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

test("keeps empty goal setup in the bot panel instead of above the conversation", async () => {
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  expect(screen.queryByRole("region", { name: "Continuar até concluir" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Definir objetivo" })).toBeNull()

  fireEvent.click(screen.getByRole("button", { name: "Painel do bot" }))
  const botPanel = await screen.findByRole("complementary", { name: "Painel de mark" })
  const goalEntry = await within(botPanel).findByRole("button", { name: "Definir objetivo" })
  expect(goalEntry).toHaveAttribute("aria-expanded", "false")

  fireEvent.click(goalEntry)
  const criterion = within(botPanel).getByRole("textbox", { name: "O que precisa estar pronto para concluir?" })
  fireEvent.change(criterion, { target: { value: "Resumo revisado." } })
  const start = within(botPanel).getByRole("button", { name: "Continuar até concluir" })
  await waitFor(() => expect(start).toBeEnabled())
  fireEvent.click(start)

  const confirmation = await within(botPanel).findByRole("status")
  expect(confirmation).toHaveTextContent("Objetivo iniciado nesta conversa")
  expect(confirmation).toBeVisible()
  expect(confirmation).toHaveFocus()
  expect(within(botPanel).queryByRole("button", { name: "Continuar até concluir" })).toBeNull()

  await screen.findByText("Em andamento")
  const goal = screen.getByRole("region", { name: "Continuar até concluir" })
  expect(within(goal).getByRole("status")).toHaveTextContent("Em andamento")
  expect(goal).toHaveTextContent("Resumo revisado.")
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
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Objetivo concluído"))

  expect(screen.queryByRole("button", { name: "Retomar" })).toBeNull()
})

test("completing a goal keeps the next goal form closed when the conversation is reopened", async () => {
  const { api, unmount } = makeFixture()
  await startGoal()
  fireEvent.click(screen.getByRole("button", { name: "Alterar orçamento" }))

  fireEvent.click(screen.getByRole("button", { name: "Concluir agora" }))
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Objetivo concluído"))

  const panel = screen.getByRole("region", { name: "Continuar até concluir" })
  expect(panel).toHaveTextContent(/^Objetivo concluídoNovo objetivo$/)
  expect(screen.getByRole("button", { name: "Novo objetivo" })).toHaveAttribute("aria-expanded", "false")
  expect(screen.queryByRole("spinbutton")).toBeNull()
  expect(screen.queryByRole("textbox")).toBeNull()

  unmount()
  makeFixture(true, api)

  await screen.findByText("Objetivo concluído")
  expect(screen.getByRole("button", { name: "Novo objetivo" })).toHaveAttribute("aria-expanded", "false")
  expect(screen.queryByRole("textbox")).toBeNull()
  expect(screen.queryByText("Avançado · Continuar até concluir")).toBeNull()
})

test("a new goal draft stays below completion, survives updates and starts the next goal", async () => {
  const { api, request } = makeFixture()
  const thread = api.getState().threads.find((candidate) => candidate.id === request.threadId)
  if (!thread) throw new Error("Missing mock conversation")
  await startGoal()
  fireEvent.click(screen.getByRole("button", { name: "Concluir agora" }))
  await screen.findByText("Objetivo concluído")

  fireEvent.click(screen.getByRole("button", { name: "Novo objetivo" }))
  const criterion = screen.getByRole("textbox", { name: "O que precisa estar pronto para concluir?" })
  fireEvent.change(criterion, {
    target: { value: "Resumo revisado com fontes." },
  })
  await act(async () => api.emit({ type: "thread.updated", thread }))

  expect(screen.getByText("Objetivo concluído")).toBeVisible()
  expect(screen.getByRole("button", { name: "Novo objetivo" })).toHaveAttribute("aria-expanded", "true")
  expect(criterion).toHaveFocus()
  expect(criterion).toBeVisible()
  expect(criterion).toHaveValue("Resumo revisado com fontes.")

  fireEvent.click(screen.getByRole("button", { name: "Continuar até concluir" }))
  await screen.findByRole("button", { name: "Pausar" })

  const starts = api.calls.filter((call) => call.route === "POST /threads/:id/goal")
  expect(starts).toHaveLength(2)
  expect(starts.at(-1)?.input).toEqual({
    requestMessageId: request.id,
    completionCriterion: "Resumo revisado com fontes.",
    maxTurns: 4,
    maxMinutes: 15,
  })
  expect(screen.getByRole("status")).toHaveTextContent("Em andamento")
  expect(screen.queryByRole("button", { name: "Novo objetivo" })).toBeNull()
})

test.each(["turns", "time"] as const)("exhausting the %s budget collapses the checkpoint", async (limit) => {
  const { api, request } = makeFixture()
  await startGoal()
  const { goal } = await api.request("GET /threads/:id/goal", {}, { id: request.threadId })
  const thread = api.getState().threads.find((candidate) => candidate.id === request.threadId)
  if (!goal || !thread) throw new Error("Missing mock goal")
  const exhausted = {
    ...goal,
    status: "budget_exhausted" as const,
    turnsUsed: limit === "turns" ? goal.maxTurns : goal.turnsUsed,
    deadlineAt: limit === "time" ? Date.now() - 1 : goal.deadlineAt,
    updatedAt: goal.updatedAt + 1,
  }
  vi.spyOn(api, "request").mockResolvedValue({ goal: exhausted })

  await act(async () => api.emit({ type: "thread.updated", thread }))

  const summary = screen.getByRole("button", { name: "Objetivo parado · limite atingido" })
  expect(summary).toHaveAttribute("aria-expanded", "false")
  expect(screen.queryByText(/turnos seguintes/)).toBeNull()
  expect(screen.queryByText("Aguardando o primeiro passo registrado.")).toBeNull()
  expect(screen.queryByText("Avançado · Continuar até concluir")).toBeNull()
  expect(screen.queryByRole("button", { name: "Retomar" })).toBeNull()

  fireEvent.click(summary)

  expect(summary).toHaveAttribute("aria-expanded", "true")
  expect(screen.getByRole("button", { name: "Retomar" })).toBeVisible()
  expect(screen.getByRole("button", { name: "Alterar orçamento" })).toBeVisible()
  expect(screen.getByText(/O limite foi atingido e o bot parou/)).toBeVisible()
  expect(screen.queryByText(/min restantes/)).toBeNull()
  expect(screen.queryByText("Aguardando o primeiro passo registrado.")).toBeNull()
})

test("without an authorized folder the ordinary conversation limit is explained", async () => {
  makeFixture(false)

  fireEvent.click(screen.getByRole("button", { name: "Definir objetivo" }))

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
    "Goal title",
    "Goal setup",
    "Goal started in conversation",
    "Goal folder required",
    "Goal budget exhausted help",
    "Change goal budget",
    "Goal completed summary",
    "Goal new",
    "Goal budget exhausted summary",
  ] as const

  expect(labels.map((key) => t(key, {}, "en"))).toEqual([
    "Continue until done",
    "Goal",
    "Set up goal",
    "Goal started in this conversation",
    "Link a project or authorize a folder to continue automatically. For now, the conversation continues one turn at a time.",
    "The limit was reached and the bot stopped. Change the budget and choose Resume to continue.",
    "Change budget",
    "Goal completed",
    "New goal",
    "Goal stopped · limit reached",
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
  const subscribeConnection = vi.fn((_listener: (connected: boolean) => void) => vi.fn())
  const api = { ...base, request: vi.fn(base.request).mockRejectedValueOnce(new Error("offline")), subscribeConnection }

  render(<GoalPanel api={api} threadId={request.threadId} bot={bot} request={request} busy={false} />)
  await screen.findByRole("alert")
  const onConnection = subscribeConnection.mock.calls[0]?.[0]
  if (!onConnection) throw new Error("Missing connection listener")

  await act(async () => onConnection(true))

  expect(screen.queryByRole("alert")).toBeNull()
  expect(api.request).toHaveBeenCalledTimes(2)
})

test("a conversation without a goal fetches once and stays idle", async () => {
  vi.useFakeTimers()
  const { api, unmount } = makeFixture()
  await act(async () => {})

  await act(async () => vi.advanceTimersByTimeAsync(10_000))

  expect(api.calls.filter((call) => call.route === "GET /threads/:id/goal")).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)
  unmount()
})

test("a hidden bot-panel entry does not poll an active goal", async () => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  const request = api.getState().messages.find((message) => message.role === "user")
  if (!bot || !request) throw new Error("Missing mock conversation")
  const { goal } = await api.request(
    "POST /threads/:id/goal",
    { requestMessageId: request.id, completionCriterion: "Entrega revisada", maxTurns: 4, maxMinutes: 15 },
    { id: request.threadId },
  )
  vi.spyOn(api, "request").mockResolvedValue({ goal })
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })

  render(<GoalPanel api={api} threadId={request.threadId} bot={bot} request={request} busy={false} surface="entry" />)
  await act(async () => {})
  await act(async () => vi.advanceTimersByTimeAsync(10_000))

  expect(api.request).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole("region", { name: "Continuar até concluir" })).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

test.each(["paused", "completed", "budget_exhausted"] as const)("a %s goal does not poll", async (status) => {
  const api = createMockApi()
  const request = api.getState().messages.find((message) => message.role === "user")
  if (!request) throw new Error("Missing mock request")
  const { goal } = await api.request(
    "POST /threads/:id/goal",
    { requestMessageId: request.id, completionCriterion: "Entrega revisada", maxTurns: 4, maxMinutes: 15 },
    { id: request.threadId },
  )
  vi.spyOn(api, "request").mockResolvedValue({ goal: { ...goal, status } })
  vi.useFakeTimers()
  const { unmount } = makeFixture(true, api)
  await act(async () => {})

  await act(async () => vi.advanceTimersByTimeAsync(10_000))

  expect(api.request).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  unmount()
})

test("only an active goal polls and pausing stops further requests", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  const { api } = makeFixture()
  await startGoal()
  const initialReads = api.calls.filter((call) => call.route === "GET /threads/:id/goal").length

  await act(async () => vi.advanceTimersByTimeAsync(2000))

  expect(api.calls.filter((call) => call.route === "GET /threads/:id/goal")).toHaveLength(initialReads + 1)

  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Pausar" })))
  const pausedReads = api.calls.filter((call) => call.route === "GET /threads/:id/goal").length

  await act(async () => vi.advanceTimersByTimeAsync(10_000))

  expect(api.calls.filter((call) => call.route === "GET /threads/:id/goal")).toHaveLength(pausedReads)
  expect(vi.getTimerCount()).toBe(0)
})

test("only events for the visible conversation refresh its goal and unmount unsubscribes", async () => {
  const { api, request, unmount } = makeFixture()
  const thread = api.getState().threads.find((candidate) => candidate.id === request.threadId)
  const otherThread = api.getState().threads.find((candidate) => candidate.id !== request.threadId)
  if (!otherThread) throw new Error("Missing other mock conversation")
  const { runs } = await api.request("GET /threads/:id/runs", {}, { id: otherThread.id })
  const run = runs[0]
  if (!thread || !run) throw new Error("Missing mock turn")
  await act(async () => {})

  await act(async () => {
    api.emit({ type: "thread.updated", thread: { ...thread, id: "other-thread" } })
    api.emit({ type: "run.updated", run: { ...run, threadId: "other-thread" } })
  })

  expect(api.calls.filter((call) => call.route === "GET /threads/:id/goal")).toHaveLength(1)

  await act(async () => api.emit({ type: "thread.updated", thread }))
  await act(async () => api.emit({ type: "run.updated", run: { ...run, threadId: request.threadId } }))

  expect(api.calls.filter((call) => call.route === "GET /threads/:id/goal")).toHaveLength(3)

  unmount()
  await act(async () => api.emit({ type: "thread.updated", thread }))

  expect(api.calls.filter((call) => call.route === "GET /threads/:id/goal")).toHaveLength(3)
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
  const messages = [request, { ...reply, parentId: request.id }, sibling]
  const selection = getGoalSelection({
    bot,
    thread: { ...thread, activeLeafId: reply.id },
    group: null,
    messages,
    runs: [],
    routineRuns: [],
    routines: [],
  })

  render(
    <GoalPanel api={api} threadId={thread.id} bot={bot} request={selection.goalRequest} busy={selection.goalBusy} />,
  )
  await startGoal()

  expect(api.calls).toContainEqual(
    expect.objectContaining({
      route: "POST /threads/:id/goal",
      input: expect.objectContaining({ requestMessageId: request.id }),
    }),
  )
})

test("reopening the entry reads once even after earlier goal changes", async () => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  const request = api.getState().messages.find((message) => message.role === "user")
  if (!bot || !request) throw new Error("Missing mock conversation")
  const getEntry = (refreshRequest: number) => (
    <GoalPanel
      api={api}
      threadId={request.threadId}
      bot={bot}
      request={request}
      busy={false}
      surface="entry"
      refreshRequest={refreshRequest}
    />
  )
  const view = render(getEntry(2))
  await screen.findByRole("button", { name: "Definir objetivo" })

  expect(api.calls.filter((call) => call.route === "GET /threads/:id/goal")).toHaveLength(1)

  view.rerender(getEntry(3))
  await waitFor(() => expect(api.calls.filter((call) => call.route === "GET /threads/:id/goal")).toHaveLength(2))
})

test.each(["other bot", "group", "routine"])("goal setup excludes a conversation for %s", async (kind) => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  const thread = api.getState().threads.find((candidate) => candidate.botId === bot?.id)
  if (!bot || !thread) throw new Error("Missing mock conversation")
  const { group } = await api.request("POST /groups", {
    name: "Equipe de exemplo",
    color: "#dc2626",
    avatarShape: "cercle",
    memberIds: [bot.id],
    coordinatorBotId: bot.id,
  })

  const selection = getGoalSelection({
    bot: kind === "other bot" ? (api.getState().bots[1] ?? null) : bot,
    thread: kind === "routine" ? { ...thread, kind: "routine" } : thread,
    group: kind === "group" ? group : null,
    messages: api.getState().messages.filter((message) => message.threadId === thread.id),
    runs: [],
    routineRuns: [],
    routines: [],
  })

  expect(selection.goalThread).toBeNull()
  expect(selection.goalRequest).toBeUndefined()
  expect(selection.goalBusy).toBe(false)
})
