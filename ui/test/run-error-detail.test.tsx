import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { Message, Run } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { runErrorFor } from "../src/runError"

const failedAt = new Date(2026, 9, 13, 20, 58).getTime()
const failed: Message = {
  id: "failed-reply",
  threadId: "thread",
  parentId: null,
  role: "assistant",
  kind: "text",
  status: "failed",
  runId: "failed-run",
  text: "",
  parts: [
    {
      type: "notice",
      level: "error",
      code: "run_failed",
      text: "timeout: A operação demorou demais. Tente novamente. [TOURI-E1008]",
    },
  ],
  sender: null,
  source: "local",
  createdAt: failedAt - 90_000,
  updatedAt: failedAt,
}
const run: Run = {
  id: "failed-run",
  threadId: "thread",
  botId: "bot",
  provider: "codex",
  trigger: "user",
  requestMessageId: null,
  replyMessageId: failed.id,
  externalTurnId: null,
  status: "failed",
  errorClass: "timeout",
  errorMessage: "A máquina não ficou pronta em 90 s: Xvfb não iniciou ou o guest não respondeu",
  usage: null,
  routineRunId: null,
  queuedAt: failed.createdAt,
  startedAt: failed.createdAt,
  finishedAt: failedAt,
}

afterEach(() => vi.useRealTimers())

it("shows a new notice's stage and safe cause with a secondary code and relative failure time", () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 14, 10))
  render(
    <VirtualMessageList
      messages={[
        {
          ...failed,
          parts: [
            {
              type: "notice",
              level: "error",
              code: "run_failed",
              text: "timeout: A conexão selada da máquina não ficou pronta a tempo. [TOURI-E1008]",
              failure: { stage: "sealed_connection", detail: "A conexão selada da máquina não ficou pronta a tempo." },
            },
          ],
        },
      ]}
      onRetry={vi.fn()}
      onSwitchBranch={vi.fn()}
    />,
  )
  const card = screen.getByRole("alert")
  expect(card).toHaveTextContent("Conexão selada · A conexão selada da máquina não ficou pronta a tempo.")
  const code = within(card).getByText("TOURI-E1008")
  expect(code.tagName).toBe("CODE")
  expect(code.closest("details")).not.toHaveAttribute("open")
  fireEvent.click(within(card).getByText("Detalhes do erro"))
  expect(code.closest("details")).toHaveAttribute("open")
  expect(within(card).getByText("falhou ontem às 20:58")).toHaveAttribute("datetime", new Date(failedAt).toISOString())
})

it("resolves a legacy generic notice from the existing runs API and retries when the subscribed VM becomes ready", async () => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  const thread = api.getState().threads.find((item) => item.botId === bot?.id)
  if (!bot || !thread) throw new Error("Missing fixture")
  bot.machine = "vm"
  thread.activeLeafId = failed.id
  const message = { ...failed, threadId: thread.id }
  const historicalRun = { ...run, threadId: thread.id, botId: bot.id }
  const machine = {
    botId: bot.id,
    status: "starting" as const,
    progress: null,
    error: null,
    memoryMb: 2048,
    createdMs: null,
    startMs: null,
  }
  const originalRequest = api.request.bind(api)
  api.request = vi.fn((route, input, path) => {
    if (path?.id === thread.id && route === "GET /threads/:id/messages")
      return Promise.resolve({ messages: [message], activeLeafId: message.id })
    if (path?.id === thread.id && route === "GET /threads/:id/runs") return Promise.resolve({ runs: [historicalRun] })
    if (route === "GET /machines")
      return Promise.resolve({
        capability: { available: true, reason: null, provider: "apple-container" },
        machines: [machine],
      })
    if (route === "POST /runs/:id/retry")
      return Promise.resolve({ run: { ...historicalRun, id: "retry-run", status: "queued" } })
    return originalRequest(route, input, path)
  }) as typeof api.request
  render(<App kernel={{ services: { api } }} />)
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Inicialização da máquina · A máquina não ficou pronta em 90 s: o ambiente gráfico não iniciou ou a máquina não respondeu",
  )
  expect(screen.getByText("Aguarde a máquina terminar de iniciar para tentar de novo.")).toBeVisible()
  expect(api.request).toHaveBeenCalledWith("GET /threads/:id/runs", { all: true }, { id: thread.id })
  expect(screen.queryByRole("button", { name: "Tentar novamente" })).not.toBeInTheDocument()
  act(() => api.emit({ type: "machine.updated", machine: { ...machine, status: "running" } }))
  expect(screen.getByText("A máquina está pronta para uma nova tentativa.")).toBeVisible()
  expect(screen.queryByText("Aguarde a máquina terminar de iniciar para tentar de novo.")).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }))
  await waitFor(() => expect(api.request).toHaveBeenCalledWith("POST /runs/:id/retry", {}, { id: run.id }))
})

it("clears sidebar and bell attention when the failure card retries before a notification resolution arrives", async () => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  const thread = api.getState().threads.find((item) => item.botId === bot?.id)
  if (!bot || !thread) throw new Error("Missing fixture")
  bot.machine = "local"
  const message = { ...failed, threadId: thread.id }
  const historicalRun = { ...run, threadId: thread.id, botId: bot.id }
  const retry: Run = {
    ...historicalRun,
    id: "retry-run",
    trigger: "retry",
    status: "queued",
    replyMessageId: null,
    queuedAt: failedAt + 100,
    startedAt: null,
    finishedAt: null,
    errorClass: null,
    errorMessage: null,
  }
  thread.activeLeafId = message.id
  const notification = api.notify({
    kind: "turn-failed",
    botId: bot.id,
    threadId: thread.id,
    title: "Turn failed",
    body: "Tente novamente.",
    createdAt: failedAt,
  })
  const originalRequest = api.request.bind(api)
  api.request = vi.fn((route, input, path) => {
    if (path?.id === thread.id && route === "GET /threads/:id/messages")
      return Promise.resolve({ messages: [message], activeLeafId: message.id })
    if (path?.id === thread.id && route === "GET /threads/:id/runs") return Promise.resolve({ runs: [historicalRun] })
    if (route === "GET /workspace/activity") return Promise.resolve({ messages: [message], runs: [historicalRun] })
    if (route === "POST /runs/:id/retry") return Promise.resolve({ run: retry })
    return originalRequest(route, input, path)
  }) as typeof api.request
  render(<App kernel={{ services: { api } }} />)
  const card = await screen.findByRole("alert")
  expect(screen.getByRole("button", { name: "Notificações, 1 precisa de atenção" })).toBeVisible()
  fireEvent.click(within(card).getByRole("button", { name: "Tentar novamente" }))
  await waitFor(() => {
    expect(api.request).toHaveBeenCalledWith("POST /runs/:id/retry", {}, { id: run.id })
    expect(document.querySelector(`[data-bot-entry="${bot.id}"]`)).toHaveAttribute("data-activity", "working")
    expect(screen.getByRole("button", { name: "Notificações", exact: true })).toBeVisible()
  })
  act(() => api.emit({ type: "run.updated", run: { ...retry, status: "running", startedAt: failedAt + 200 } }))
  expect(document.querySelector(`[data-bot-entry="${bot.id}"]`)).toHaveAttribute("data-activity", "working")
  expect(screen.queryByText("Aguardando você: revise a tarefa interrompida")).not.toBeInTheDocument()
  expect(notification.resolvedAt).toBeNull()
})

it("collapses an old failure after a later success in the same thread, and expands its detail", () => {
  const props = { messages: [failed], runs: [run], onRetry: vi.fn(), onSwitchBranch: vi.fn() }
  const view = render(<VirtualMessageList {...props} />)
  expect(screen.getByRole("alert")).toBeVisible()
  const later = { ...run, id: "later", status: "succeeded" as const, finishedAt: failedAt + 60_000 }
  view.rerender(<VirtualMessageList {...props} runs={[run, { ...later, threadId: "other" }]} />)
  expect(screen.getByRole("alert")).toBeVisible()
  view.rerender(<VirtualMessageList {...props} runs={[run, later]} />)
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  const summary = screen.getByRole("button", { name: /houve uma resposta depois/ })
  expect(summary).toHaveAttribute("aria-expanded", "false")
  expect(within(summary).queryByText("TOURI-E1008")).toBeNull()
  fireEvent.click(summary)
  expect(summary).toHaveAttribute("aria-expanded", "true")
  expect(screen.getByRole("alert")).toHaveTextContent("A máquina não ficou pronta em 90 s")
})

it.each([
  ["A conexão selada da máquina não ficou pronta a tempo", "sealed_connection", "conexão segura"],
  ["O login na máquina não ficou pronto em 15 s", "provider_login", "Confira o login"],
  ["O Codex na máquina não produziu saída em 90 s", "provider_output", "O provedor não respondeu"],
])("gives a specific stage and hint for %s", (errorMessage, stage, hint) => {
  expect(runErrorFor(failed, { ...run, errorMessage })).toMatchObject({ stage, hint: expect.stringContaining(hint) })
})

it("shows a clear notice when a queued group turn loses its conversation", () => {
  expect(
    runErrorFor(failed, {
      ...run,
      errorClass: "group_context_missing",
      errorMessage: "O grupo ou a conversa não existe mais. Este turno não foi executado.",
    }),
  ).toMatchObject({
    title: "O grupo ou a conversa não existe mais",
    detail: "O grupo ou a conversa não existe mais. Este turno não foi executado.",
  })
})

it("sanitizes legacy diagnostics and untrusted notice payloads before rendering", () => {
  const privateText =
    "O login na máquina não ficou pronto em 15 s. stderr: /home/alice/.config/token /Users/alice/key $HOME/private ~/key token=secret sk-private Bearer abc123"
  const parts: Message["parts"] = [
    {
      type: "notice",
      level: "error",
      code: "run_failed",
      text: privateText,
      failure: { stage: "provider_login", detail: privateText },
    },
  ]
  const { container } = render(
    <VirtualMessageList
      messages={[{ ...failed, parts }]}
      runs={[{ ...run, errorMessage: privateText }]}
      onRetry={vi.fn()}
      onSwitchBranch={vi.fn()}
    />,
  )
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Login no provedor · O login na máquina não ficou pronto em 15 s.",
  )
  expect(container.textContent).not.toMatch(/stderr|alice|HOME|private|secret|Bearer|abc123/)
})
