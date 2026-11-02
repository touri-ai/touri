import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { Message, MessagePart, Run } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { createSendJournal } from "../src/api/sendJournal"
import { BotComputer } from "../src/components/BotComputer"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { ErrorNotice } from "../src/components/ErrorNotice"
import { FailureActionContext } from "../src/components/FailureActionContext"
import { NotificationBell } from "../src/components/NotificationCenter"
import * as revealEvents from "../src/components/revealEvent"
import { errorRecovery } from "../src/errorRecovery"
import { ApiError } from "../src/errors"
import { requestTaskReview } from "../src/recoveryEvents"
import { RecoveryTasksContext } from "../src/useRecoveryTasks"
import { getTaskReviewHistory } from "./fixtures/taskReviewHistory"

const cases = [
  ['network error: ECONNRESET {"stack":"transport.ts:42"}', "Não consegui conectar à sua IA.", "Tentar novamente"],
  ['401 Unauthorized {"stack":"transport.ts:42"}', "Entre novamente no", "Entrar na conta"],
  ["429 rate_limit retry_after: 60", "atingiu o limite de uso. Tente após", "Ver tarefa"],
  ["429 rate_limit", "atingiu o limite de uso. Tente mais tarde.", "Ver tarefa"],
  ['ENOSPC: no space left on device {"stack":"storage.ts:42"}', "Não há espaço para salvar", "Verificar armazenamento"],
  [
    'app_restart after confirmed write {"stack":"transport.ts:42"}',
    "Algumas ações podem ter sido concluídas.",
    "Retomar tarefa",
  ],
] as const
const failed = (diagnostic: string, parts: MessagePart[] = []): Message => ({
  id: "failed-reply",
  threadId: "thread",
  parentId: null,
  role: "assistant",
  kind: "text",
  status: "failed",
  runId: "failed-run",
  text: "",
  parts: [...parts, { type: "notice", level: "error", code: "run_failed", text: diagnostic }],
  sender: null,
  source: "local",
  createdAt: Date.now() - 2,
  updatedAt: Date.now(),
})
const runFor = (errorMessage: string): Run => ({
  id: "failed-run",
  threadId: "thread",
  botId: "bot",
  provider: "codex",
  trigger: "user",
  requestMessageId: "saved-request",
  replyMessageId: "failed-reply",
  externalTurnId: null,
  status: "failed",
  errorClass: "unknown",
  errorMessage,
  usage: null,
  routineRunId: null,
  queuedAt: Date.now() - 2,
  startedAt: Date.now() - 1,
  finishedAt: Date.now(),
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const expectClosedDiagnostics = (container: HTMLElement) => {
  const details = container.querySelectorAll(".error-details")
  expect(details.length).toBeGreaterThan(0)
  for (const detail of details) expect(detail).toHaveAttribute("data-open", "false")
  const visible = container.cloneNode(true) as HTMLElement
  for (const detail of visible.querySelectorAll(".ds-disclosure")) detail.remove()
  expect(visible.textContent).not.toMatch(
    /ECONNRESET|ENOSPC|Unauthorized|rate_limit|retry_after|transport\.ts|storage\.ts|[{}]|TOURI-E\d/,
  )
}
it.each(cases)("projects %s in chat, bell, global notice and computer", async (diagnostic, message, action) => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Missing bot fixture")
  bot.machine = "vm"
  const failedMessage = failed(diagnostic)
  const run = runFor(diagnostic)
  const chat = render(
    <VirtualMessageList messages={[failedMessage]} runs={[run]} onRetry={vi.fn()} onSwitchBranch={vi.fn()} />,
  )
  expect(screen.getByRole("alert")).toHaveTextContent(message)
  expect(screen.getByRole("button", { name: action })).toBeVisible()
  expectClosedDiagnostics(chat.container)
  chat.unmount()
  const item = api.notify({
    kind: "turn-failed",
    botId: bot.id,
    threadId: "thread",
    title: diagnostic,
    body: diagnostic,
    createdAt: Date.now(),
  })
  const bell = render(
    <NotificationBell
      notifications={[item]}
      messages={[failedMessage]}
      runs={[run]}
      actions={{ open: vi.fn(), dismiss: vi.fn(), dismissAll: vi.fn(), respond: vi.fn(), reply: vi.fn() }}
    />,
  )
  fireEvent.click(screen.getByRole("button", { name: /Notificações/ }))
  const row = screen.getByTestId("notification-row")
  expect(row).toHaveTextContent(message)
  expect(within(row).getByRole("button", { name: action })).toBeVisible()
  expectClosedDiagnostics(row)
  bell.unmount()
  const computer = render(
    <BotComputer
      api={api}
      bot={bot}
      machine={{
        botId: bot.id,
        status: "error",
        progress: null,
        error: diagnostic,
        memoryMb: 2048,
        createdMs: null,
        startMs: null,
      }}
    />,
  )
  expect(screen.getByRole("alert")).toHaveTextContent(message)
  expect(screen.getByRole("button", { name: action })).toBeVisible()
  expectClosedDiagnostics(computer.container)
  computer.unmount()
  const app = render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("button", { name: /Notificações/ })
  act(() => api.emit({ type: "notify", title: "Turn failed", body: diagnostic }))
  const global = document.querySelector<HTMLElement>(".notice-bar .error-notice")
  if (!global) throw new Error("Missing global notice")
  expect(global).toHaveTextContent(message)
  expect(within(global).getByRole("button", { name: action })).toBeVisible()
  expectClosedDiagnostics(global)
  app.unmount()
})

it("shows the stored group and conversation failure reason in the failed-turn notice", () => {
  const errorMessage = "O grupo ou a conversa não existe mais. Este turno não foi executado."
  const failedMessage = failed(errorMessage)
  const run = { ...runFor(errorMessage), errorClass: "group_context_missing" as const }
  render(<VirtualMessageList messages={[failedMessage]} runs={[run]} onRetry={vi.fn()} onSwitchBranch={vi.fn()} />)

  expect(screen.getByRole("alert")).toHaveTextContent(errorMessage)
  expect(screen.queryByRole("button", { name: "Tentar novamente" })).toBeNull()
  expect(errorRecovery(errorMessage, { errorClass: run.errorClass, locale: "en" }).message).toBe(
    "The group or conversation no longer exists. This turn was not run.",
  )
})

it("uses English copy and only promises saved messages when there is evidence", () => {
  expect(errorRecovery("network error").message).not.toContain("está salva")
  expect(errorRecovery("network error", { savedMessage: true }).message).toBe(
    "Não consegui conectar à sua IA. Sua mensagem está salva.",
  )
  for (const [error] of cases)
    expect(errorRecovery(error, { locale: "en" }).message).not.toMatch(/Não|atingiu|novamente|interrompida/)
  expect(errorRecovery('unrecognized {"stack":42}').message).toBe(
    "Não foi possível concluir esta ação. Confira os detalhes do erro.",
  )
})
it("preserves Retry-After metadata", async () => {
  const { createApiClient } = await import("../src/api/client")
  const before = Date.now()
  const api = createApiClient({
    endpoint: { baseUrl: "", wsUrl: "", token: "" },
    fetchImpl: async () => Response.json({ error: "limit" }, { status: 429, headers: { "Retry-After": "120" } }),
  })
  const error = await api.request("GET /health", {}).catch((reason: unknown) => reason)
  expect(error).toBeInstanceOf(ApiError)
  expect(error.retryAt).toBeGreaterThanOrEqual(before + 120000)
  expect(errorRecovery(error).message).toContain("Tente após")
  expect(errorRecovery(new ApiError(429, "limit")).message).toContain("Tente mais tarde")
  expect(errorRecovery("429 retry_after: 60", { now: 120000, occurredAt: 1 }).message).toContain("Tente mais tarde")
})
it("discloses diagnostics only on click and prevents concurrent recovery", async () => {
  let finish = () => {}
  const recover = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  render(<ErrorNotice error="network error: ECONNRESET" onAction={recover} />)
  const details = screen.getByText("network error: ECONNRESET")
  expect(details).not.toBeVisible()
  fireEvent.click(screen.getByText("Detalhes do erro"))
  expect(details).toBeVisible()
  const retry = screen.getByRole("button", { name: "Tentar novamente" })
  fireEvent.click(retry)
  fireEvent.click(retry)
  expect(recover).toHaveBeenCalledTimes(1)
  act(() => finish())
  await waitFor(() => expect(retry).toBeEnabled())
})
it("routes login and storage to recoverable settings", () => {
  const open = vi.fn()
  const view = render(
    <FailureActionContext.Provider value={open}>
      <ErrorNotice error={new ApiError(401, "unauthorized")} />
    </FailureActionContext.Provider>,
  )
  fireEvent.click(screen.getByRole("button", { name: "Entrar na conta" }))
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ kind: "setting", settingId: "providerLogin" }))
  view.rerender(
    <FailureActionContext.Provider value={open}>
      <ErrorNotice error={new ApiError(507, "ENOSPC")} />
    </FailureActionContext.Provider>,
  )
  fireEvent.click(screen.getByRole("button", { name: "Verificar armazenamento" }))
  expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "doctor" }))
})
it("never replays a confirmed write on review or resume", () => {
  const retry = vi.fn()
  const write: MessagePart = {
    type: "file_change",
    callId: "saved-file",
    paths: ["notes.md"],
    diff: null,
    completedOutcome: "succeeded",
  }
  render(
    <VirtualMessageList
      messages={[failed("network error", [write])]}
      runs={[runFor("network error")]}
      onRetry={retry}
      onSwitchBranch={vi.fn()}
    />,
  )
  expect(screen.queryByRole("button", { name: "Tentar novamente" })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Ver ações realizadas" }))
  expect(screen.getByRole("region", { name: "Ações registradas" })).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Retomar tarefa" }))
  expect(retry).not.toHaveBeenCalled()
})
it("reconciles lost send acknowledgements with the same nonce and stops permanent permission failures", async () => {
  vi.useFakeTimers()
  const saved = new Map<string, string>()
  const inputs: unknown[] = []
  const request = vi.fn(async (_route, input) => {
    inputs.push(structuredClone(input))
    if (inputs.length === 1) throw new ApiError(0, "", undefined, "TOURI-E1010")
    throw new ApiError(403, "Forbidden")
  })
  const journal = createSendJournal({
    request: request as never,
    emit: vi.fn(),
    storage: {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => {
        saved.set(key, value)
      },
    },
  })
  await journal.enqueue({
    threadId: "thread",
    parentId: null,
    text: "Mensagem salva",
    clientNonce: "same-send",
    deadline: Date.now() + 60000,
  })
  await vi.advanceTimersByTimeAsync(10000)
  expect(inputs).toHaveLength(2)
  expect(inputs[0]).toEqual(inputs[1])
  expect(journal.messages()).toHaveLength(1)
  expect(journal.messages()[0]?.delivery?.status).toBe("failed")
  journal.reconnect()
  await vi.advanceTimersByTimeAsync(10000)
  expect(inputs).toHaveLength(2)
  journal.stop()
})

it("preserves the composer draft through login recovery and resume review", async () => {
  const api = createMockApi()
  const { bots, threads } = api.getState()
  const bot = bots[0]
  const thread = threads.find((item) => item.botId === bot?.id)
  if (!bot || !thread) throw new Error("Missing conversation")
  const message = { ...failed("401 Unauthorized"), threadId: thread.id }
  const run = { ...runFor("401 Unauthorized"), threadId: thread.id, botId: bot.id }
  const original = api.request.bind(api)
  api.request = vi.fn((route, input, path) => {
    if (route === "GET /threads/:id/messages") return Promise.resolve({ messages: [message], activeLeafId: message.id })
    if (route === "GET /threads/:id/runs") return Promise.resolve({ runs: [run] })
    return original(route, input, path)
  }) as typeof api.request
  render(<App kernel={{ services: { api } }} />)
  const box = await screen.findByRole("textbox", { name: /^Mensagem para/ })
  fireEvent.change(box, { target: { value: "Meu rascunho preservado" } })
  const card = document.querySelector<HTMLElement>(".message-error")
  if (!card) throw new Error("Missing failure card")
  fireEvent.click(within(card).getByRole("button", { name: "Entrar na conta" }))
  await screen.findByRole("dialog")
  fireEvent.click(screen.getByRole("button", { name: "Fechar diálogo" }))
  expect(box).toHaveValue("Meu rascunho preservado")
  const { requestTaskResume } = await import("../src/recoveryEvents")
  act(() => requestTaskResume(thread.id))
  expect(box).toHaveValue("Meu rascunho preservado")
  expect(api.request).not.toHaveBeenCalledWith("POST /runs/:id/retry", expect.anything(), expect.anything())
})

it("closes the bell before running recovery for its own notification", async () => {
  const api = createMockApi()
  const item = api.notify({ kind: "turn-failed", title: "Turn failed", body: "401 Unauthorized" })
  const recover = vi.fn(async () => {})
  render(
    <NotificationBell
      notifications={[item]}
      actions={{ open: vi.fn(), recover, dismiss: vi.fn(), dismissAll: vi.fn(), respond: vi.fn(), reply: vi.fn() }}
    />,
  )
  fireEvent.click(screen.getByRole("button", { name: /Notificações/ }))
  fireEvent.click(screen.getByRole("button", { name: "Entrar na conta" }))
  await waitFor(() => expect(recover).toHaveBeenCalledWith(item, "login"))
  expect(screen.getByRole("button", { name: /Notificações/ })).toHaveAttribute("aria-expanded", "false")
})

it.each([false, true])("opens recorded actions from a notification (later reply: %s)", async (hasLaterReply) => {
  const api = createMockApi()
  const { bots, threads } = api.getState()
  const bot = bots[0]
  const thread = threads.find((item) => item.botId === bot?.id)
  if (!bot || !thread) throw new Error("Missing conversation")
  const { messages, run } = getTaskReviewHistory({
    threadId: thread.id,
    botId: bot.id,
    now: Date.now(),
    hasLaterReply,
  })
  api.notify({ kind: "turn-failed", botId: bot.id, threadId: thread.id, title: "Turn failed", body: "app_restart" })
  const getResponse: typeof api.request = async (route, input, path) => {
    if (route === "GET /threads/:id/messages") return { messages, activeLeafId: messages.at(-1)?.id ?? null } as never
    if (route === "GET /threads/:id/runs") return { runs: [run] } as never
    if (route === "GET /workspace/activity") return { runs: [run], messages } as never

    return api.request(route, input, path)
  }
  const request = vi.fn(getResponse)
  const client = Object.assign({}, api, { request })
  render(<App kernel={{ services: { api: client } }} />)
  await screen.findByRole("textbox", { name: /^Mensagem para/ })
  await screen.findByText("Etapa registrada da tarefa fictícia.")
  if (hasLaterReply) await screen.findByText("Resposta posterior da tarefa fictícia.")
  if (hasLaterReply)
    expect(document.querySelector(".message-error-history > button")).toHaveAttribute("aria-expanded", "false")
  expect(screen.queryByRole("region", { name: "Ações registradas" })).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole("button", { name: /Notificações/ }))
  const row = screen.getByTestId("notification-row")
  fireEvent.click(within(row).getByRole("button", { name: "Ver ações realizadas" }))

  const actions = await screen.findByRole("region", { name: "Ações registradas" })
  expect(actions).toBeVisible()
  expect(screen.getByRole("button", { name: /Notificações/ })).toHaveAttribute("aria-expanded", "false")
  expect(request).not.toHaveBeenCalledWith("POST /runs/:id/retry", expect.anything(), expect.anything())
})

it("reveals a resolved interruption after rendering its actions and repeats the review", async () => {
  const api = createMockApi({ scenario: "interrupted-tasks" })
  const { tasks } = await api.request("GET /recovery", {})
  const task = tasks.find((item) => item.runId !== null)
  if (!task) throw new Error("Missing interrupted task fixture")
  const { messages, run } = getTaskReviewHistory({
    threadId: "review-thread",
    botId: "review-bot",
    now: Date.now(),
    hasLaterReply: false,
  })
  const resolved = Object.assign({}, task, {
    id: `run:${run.id}`,
    runId: run.id,
    notification: Object.assign({}, task.notification, {
      botId: run.botId,
      threadId: run.threadId,
      resolvedAt: Date.now(),
    }),
  })
  const reveal = vi.spyOn(revealEvents, "requestReveal")
  render(
    <RecoveryTasksContext.Provider value={[resolved]}>
      <VirtualMessageList messages={messages} runs={[run]} onRetry={vi.fn()} onSwitchBranch={vi.fn()} />
    </RecoveryTasksContext.Provider>,
  )
  const disclosure = screen.getByRole("button", { name: "Ver erro", exact: true })
  expect(disclosure).toHaveAttribute("aria-expanded", "false")

  act(() => requestTaskReview(run.id))

  const actions = screen.getByRole("region", { name: "Ações registradas" })
  expect(actions).toBeVisible()
  expect(disclosure).toHaveAttribute("aria-expanded", "true")
  expect(reveal).toHaveBeenCalledWith(actions)

  const calls = reveal.mock.calls.length

  act(() => requestTaskReview(run.id))

  expect(reveal).toHaveBeenCalledTimes(calls + 1)
  expect(reveal).toHaveBeenLastCalledWith(actions)

  fireEvent.click(disclosure)
  expect(screen.queryByRole("region", { name: "Ações registradas" })).not.toBeInTheDocument()

  act(() => requestTaskReview(run.id))

  const reopenedActions = screen.getByRole("region", { name: "Ações registradas" })
  expect(reopenedActions).toBeVisible()
  expect(reveal).toHaveBeenLastCalledWith(reopenedActions)
})

it("keeps recovery actions after an unrelated channel request finishes", () => {
  const diagnostic = "app_restart after confirmed write"
  const message = failed(diagnostic)
  const run = { ...runFor(diagnostic), groupTurnId: "old-channel-turn", errorClass: "app_restart" as const }
  const unrelated: Run = {
    ...run,
    id: "unrelated-run",
    groupTurnId: "new-channel-turn",
    requestMessageId: "different-request",
    status: "succeeded",
    queuedAt: run.queuedAt + 10,
    finishedAt: (run.finishedAt ?? 0) + 20,
    errorClass: null,
    errorMessage: null,
  }

  render(<VirtualMessageList messages={[message]} runs={[run, unrelated]} onRetry={vi.fn()} onSwitchBranch={vi.fn()} />)

  expect(screen.getByRole("button", { name: "Retomar tarefa", exact: true })).toBeVisible()
  expect(screen.getByRole("alert")).toBeVisible()
})

it("keeps a failed member's recovery actions when another member finishes the shared request", () => {
  const diagnostic = "app_restart after confirmed write"
  const message = failed(diagnostic)
  const run = { ...runFor(diagnostic), groupTurnId: "shared-turn", errorClass: "app_restart" as const }
  const root: Run = { ...runFor(diagnostic), id: "shared-turn", requestMessageId: "shared-request" }
  const other: Run = {
    ...run,
    id: "other-member",
    botId: "other-bot",
    requestMessageId: "other-private-request",
    status: "succeeded",
    queuedAt: run.queuedAt + 10,
    finishedAt: (run.finishedAt ?? 0) + 20,
    errorClass: null,
    errorMessage: null,
  }

  render(
    <VirtualMessageList messages={[message]} runs={[run, root, other]} onRetry={vi.fn()} onSwitchBranch={vi.fn()} />,
  )

  expect(screen.getByRole("button", { name: "Retomar tarefa", exact: true })).toBeVisible()
  expect(screen.getByRole("alert")).toBeVisible()
})

it.each([false, true])("read recovery never retries a task (visible failed reply: %s)", async (hasReply) => {
  const api = createMockApi()
  const { thread } = await api.request("POST /groups", {
    name: "Demonstração",
    color: "#558866",
    avatarShape: "cercle",
    memberIds: ["bot-mark"],
    coordinatorBotId: null,
  })
  await api.request(
    "POST /threads/:id/messages",
    { text: "Plano salvo.", parentId: null, attachmentIds: [], sendId: crypto.randomUUID() },
    { id: thread.id },
  )
  const diagnostic = "History request failed"
  const run = { ...runFor(diagnostic), threadId: thread.id, botId: thread.botId }
  api.notify({ kind: "turn-failed", botId: thread.botId, threadId: thread.id, title: "Turn failed", body: diagnostic })
  let failing = true
  const read: typeof api.request = async (route, input, path) => {
    if (route === "GET /threads/:id/messages" && path?.id === thread.id && failing) throw new Error(diagnostic)
    if (route === "GET /threads/:id/runs" && path?.id === thread.id) return { runs: [run] } as never
    if (route === "GET /workspace/activity") return { runs: [run], messages: [] } as never
    return api.request(route, input, path)
  }
  const request = vi.fn(read)
  const client = Object.assign({}, api, { request })

  render(<App kernel={{ services: { api: client } }} />)
  fireEvent.click(await screen.findByRole("tab", { name: /^Work,/ }))
  const channels = await screen.findByRole("region", { name: "Canais", exact: true })
  fireEvent.click(await within(channels).findByText("Demonstração", { exact: true }))
  fireEvent.click(await screen.findByRole("button", { name: /Notificações/ }))
  await screen.findByTestId("notification-row")
  fireEvent.click(screen.getByRole("button", { name: /Notificações/ }))
  act(() => {
    api.emit({ type: "run.updated", run })
    if (hasReply) api.emit({ type: "message.created", message: { ...failed(diagnostic), threadId: thread.id } })
  })
  const readFailure = await screen.findByText("Não conseguimos carregar as mensagens novas.", undefined, {
    timeout: 4000,
  })
  const readNotice = readFailure.closest<HTMLElement>(".conversation-notice")
  if (!readNotice) throw new Error("Missing history recovery notice")
  const retry = within(readNotice).getByRole("button", { name: "Tentar de novo", exact: true })
  failing = false
  fireEvent.click(retry)

  const history = await screen.findByRole("region", { name: "Histórico da conversa" })
  expect(await within(history).findByText("Plano salvo.")).toBeVisible()
  expect(request).not.toHaveBeenCalledWith("POST /runs/:id/retry", expect.anything(), expect.anything())
})

it("names recorded actions and exposes uncertain outcomes before opening their details", () => {
  const command: MessagePart = {
    type: "command",
    callId: "uncertain-command",
    command: "ls notas/",
    cwd: ".",
    exitCode: null,
    outputTail: "",
    resolution: "interrupted",
  }
  const savedFile: MessagePart = {
    type: "file_change",
    callId: "saved-file",
    paths: ["review-notes.md"],
    diff: null,
    completedOutcome: "succeeded",
  }
  const message = failed("app_restart", [command, savedFile])
  render(
    <VirtualMessageList
      messages={[message]}
      runs={[runFor("app_restart")]}
      onRetry={vi.fn()}
      onSwitchBranch={vi.fn()}
    />,
  )

  fireEvent.click(screen.getByRole("button", { name: "Ver ações realizadas", exact: true }))

  const actions = screen.getByRole("region", { name: "Ações registradas", exact: true })
  const commandDetails = within(actions).getByRole("button", { name: "Comando: ls notas/ · Resultado incerto" })
  expect(commandDetails).toBeVisible()
  expect(commandDetails).toHaveAttribute("aria-expanded", "false")
  expect(within(actions).getByRole("button", { name: "Arquivo alterado: review-notes.md" })).toBeVisible()
  expect(within(actions).queryByText(/Ações registradas \d/)).not.toBeInTheDocument()
})

it("sanitizes recorded action labels as well as expanded details", () => {
  const command: MessagePart = {
    type: "command",
    callId: "redacted-command",
    command: "echo password=synthetic-private-value",
    cwd: ".",
    exitCode: 0,
    outputTail: "",
  }
  render(
    <VirtualMessageList
      messages={[failed("app_restart", [command])]}
      runs={[runFor("app_restart")]}
      onRetry={vi.fn()}
      onSwitchBranch={vi.fn()}
    />,
  )

  fireEvent.click(screen.getByRole("button", { name: "Ver ações realizadas", exact: true }))
  const actions = screen.getByRole("region", { name: "Ações registradas", exact: true })
  fireEvent.click(within(actions).getByRole("button", { name: "Comando: echo password=[segredo]" }))

  expect(actions).not.toHaveTextContent("synthetic-private-value")
  expect(within(actions).getByText("echo password=[segredo]", { selector: "pre" })).toBeVisible()
})
