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
import { errorRecovery } from "../src/errorRecovery"
import { ApiError } from "../src/errors"

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
afterEach(() => vi.useRealTimers())
const expectClosedDiagnostics = (container: HTMLElement) => {
  const details = container.querySelectorAll(".error-details")
  expect(details.length).toBeGreaterThan(0)
  for (const detail of details) expect(detail).not.toHaveAttribute("open")
  const visible = container.cloneNode(true) as HTMLElement
  for (const detail of visible.querySelectorAll("details")) detail.remove()
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
it("reconciles lost send acknowledgements with the same nonce and stops permanent failures", async () => {
  vi.useFakeTimers()
  const saved = new Map<string, string>()
  const inputs: unknown[] = []
  const request = vi.fn(async (_route, input) => {
    inputs.push(structuredClone(input))
    if (inputs.length === 1) throw new ApiError(0, "", undefined, "TOURI-E1010")
    throw new ApiError(401, "Unauthorized")
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

it("opens recorded actions from a notification for a restart-interrupted run", async () => {
  const api = createMockApi()
  const { bots, threads } = api.getState()
  const bot = bots[0]
  const thread = threads.find((item) => item.botId === bot?.id)
  if (!bot || !thread) throw new Error("Missing conversation")
  const message = {
    ...failed("app_restart", [
      { type: "command", callId: "saved", command: "save notes.md", output: "saved", exitCode: 0 },
    ]),
    threadId: thread.id,
  }
  const run: Run = {
    ...runFor("app_restart"),
    threadId: thread.id,
    botId: bot.id,
    status: "interrupted",
    errorClass: "app_restart",
  }
  api.notify({ kind: "turn-failed", botId: bot.id, threadId: thread.id, title: "Turn failed", body: "app_restart" })
  const original = api.request.bind(api)
  api.request = vi.fn((route, input, path) => {
    if (route === "GET /threads/:id/messages") return Promise.resolve({ messages: [message], activeLeafId: message.id })
    if (route === "GET /threads/:id/runs") return Promise.resolve({ runs: [run] })
    if (route === "GET /workspace/activity") return Promise.resolve({ runs: [run], messages: [message] })
    return original(route, input, path)
  }) as typeof api.request
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: /^Mensagem para/ })
  fireEvent.click(screen.getByRole("button", { name: /Notificações/ }))
  const row = screen.getByTestId("notification-row")
  fireEvent.click(within(row).getByRole("button", { name: "Ver ações realizadas" }))
  expect(await screen.findByRole("region", { name: "Ações registradas" })).toBeVisible()
  expect(api.request).not.toHaveBeenCalledWith("POST /runs/:id/retry", expect.anything(), expect.anything())
})
