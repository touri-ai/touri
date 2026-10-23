import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { Message, Run } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { getAutomaticResumeMessages } from "../src/components/automaticResumeMessages"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { SettingsModal } from "../src/components/Modals"
import { setDocumentLanguage } from "../src/documentLanguage"

afterEach(() => {
  cleanup()
  setDocumentLanguage("pt-BR", document.documentElement)
})

const message = (overrides: Partial<Message>): Message => ({
  id: "m",
  threadId: "t1",
  parentId: null,
  role: "assistant",
  kind: "text",
  status: "complete",
  runId: null,
  text: "",
  parts: [],
  sender: null,
  source: "local",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

it.each(["Retomado após reinício do touri", "Retomado após aprovação de acesso"])(
  "shows %s as a marker in the thread, not as a message",
  (text) => {
    render(
      <VirtualMessageList
        messages={[
          message({ id: "partial", text: "Comecei a tabela.", parts: [{ type: "text", text: "Comecei a tabela." }] }),
          message({
            id: "marker",
            parentId: "partial",
            role: "system",
            kind: "notice",
            text,
            parts: [{ type: "notice", level: "info", code: "run_resumed", text }],
            createdAt: 2,
          }),
          message({
            id: "reply",
            parentId: "marker",
            text: "Terminei.",
            parts: [{ type: "text", text: "Terminei." }],
            createdAt: 3,
          }),
        ]}
        onSwitchBranch={async () => {}}
        onRetry={async () => {}}
      />,
    )
    const marker = screen.getByRole("note")
    expect(marker).toHaveTextContent(text)
    expect(marker).toHaveClass("run-resumed-marker")
    expect(marker.closest(".message-bubble")).toBeNull()
    expect(screen.getByText("Terminei.")).toBeInTheDocument()
  },
)

it.each([
  { locale: "pt-BR" as const, expected: "Retomando a resposta automaticamente…" },
  { locale: "en" as const, expected: "Resuming the answer automatically…" },
])("localizes the automatic channel recovery marker to $locale", ({ locale, expected }) => {
  setDocumentLanguage(locale, document.documentElement)
  const text = "Retomando a resposta automaticamente…"
  const marker = message({
    role: "system",
    kind: "notice",
    text,
    parts: [{ type: "notice", level: "info", code: "run_resumed", text }],
  })

  render(<VirtualMessageList messages={[marker]} onSwitchBranch={vi.fn()} onRetry={vi.fn()} />)

  expect(screen.getByRole("note")).toHaveTextContent(expected)
})

it.each([
  {
    locale: "pt-BR" as const,
    expected: "A sessão anterior não pôde ser retomada. Vou continuar com o histórico salvo em uma nova sessão.",
  },
  {
    locale: "en" as const,
    expected: "The previous session could not be resumed. I will continue with the saved history in a new session.",
  },
])("explains fresh-session recovery in $locale", ({ locale, expected }) => {
  setDocumentLanguage(locale, document.documentElement)
  const text = "A sessão anterior não pôde ser retomada. Vou continuar com o histórico salvo em uma nova sessão."
  const marker = message({
    role: "system",
    kind: "notice",
    text,
    parts: [{ type: "notice", level: "info", code: "run_resumed", text }],
  })

  render(<VirtualMessageList messages={[marker]} onSwitchBranch={vi.fn()} onRetry={vi.fn()} />)

  expect(screen.getByRole("note")).toHaveTextContent(expected)
})

it("the resume setting is on by default and saving it off persists through the settings API", async () => {
  const onSave = vi.fn(async () => undefined)
  render(<SettingsModal settings={null} initialSection="general" onClose={() => undefined} onSave={onSave} />)
  const toggle = screen.getByRole("switch", { name: /Retomar turnos interrompidos/ })
  expect(toggle).toBeChecked()
  fireEvent.click(toggle)
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Salvar preferências" })))
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ resumeInterruptedTurns: false }))
})

it("the mock scenario seeds an interrupted turn followed by its continuation", async () => {
  const api = createMockApi({ scenario: "resumed-turn" })
  const { messages } = await api.request("GET /threads/:id/messages", {}, { id: "thread-mark" })
  const marker = messages.find((item) =>
    item.parts.some((part) => part.type === "notice" && part.code === "run_resumed"),
  )
  expect(marker?.text).toBe("Retomado após reinício do touri")
  expect(messages.at(-1)).toMatchObject({ parentId: marker?.id, role: "assistant", status: "complete" })
  expect((await api.request("GET /settings", {})).settings.resumeInterruptedTurns).toBe(true)
})

const getInterruptedRun = (overrides: Partial<Run> = {}): Run => ({
  id: "original",
  threadId: "t1",
  botId: "b",
  provider: "codex",
  trigger: "user",
  requestMessageId: "request",
  replyMessageId: "partial",
  externalTurnId: "turn",
  status: "failed",
  errorClass: "timeout",
  errorMessage: "Interrupted",
  usage: null,
  routineRunId: null,
  queuedAt: 1,
  startedAt: 1,
  finishedAt: 2,
  ...overrides,
})

const getInterruptedMessage = () =>
  message({
    id: "partial",
    runId: "original",
    status: "failed",
    text: "Preparei a tabela.",
    parts: [
      { type: "text", text: "Preparei a tabela." },
      { type: "notice", code: "run_failed", level: "error", text: "timeout: Interrupted" },
    ],
  })

it("shows automatic recovery instead of an error or manual resume while waiting", () => {
  render(
    <VirtualMessageList
      messages={[getInterruptedMessage()]}
      runs={[getInterruptedRun({ automaticResumePending: true })]}
      onSwitchBranch={async () => {}}
      onRetry={async () => {}}
    />,
  )

  expect(screen.getByText("Retomando automaticamente…")).toHaveAttribute("role", "status")
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Retomar tarefa" })).not.toBeInTheDocument()
})

it("keeps a running continuation in the original card before its first response", () => {
  render(
    <VirtualMessageList
      messages={[getInterruptedMessage()]}
      runs={[
        getInterruptedRun(),
        getInterruptedRun({
          id: "retry",
          status: "running",
          queuedAt: 3,
          automaticResumeFromRunId: "original",
          replyMessageId: null,
        }),
      ]}
      onSwitchBranch={async () => {}}
      onRetry={async () => {}}
    />,
  )

  expect(screen.getByText("Retomando automaticamente…")).toHaveAttribute("role", "status")
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  expect(document.querySelectorAll(".message-bubble")).toHaveLength(1)
})

it("combines partial output and the recovered answer in one original card", () => {
  render(
    <VirtualMessageList
      messages={[
        getInterruptedMessage(),
        message({
          id: "answer",
          runId: "retry",
          text: "Relatório concluído.",
          parts: [{ type: "text", text: "Relatório concluído." }],
        }),
      ]}
      runs={[
        getInterruptedRun(),
        getInterruptedRun({
          id: "retry",
          status: "succeeded",
          errorClass: null,
          queuedAt: 3,
          automaticResumeFromRunId: "original",
        }),
      ]}
      onSwitchBranch={async () => {}}
      onRetry={async () => {}}
    />,
  )

  expect(screen.getByText(/Preparei a tabela/)).toHaveTextContent("Relatório concluído.")
  expect(screen.getByText(/Relatório concluído/)).toHaveTextContent("Preparei a tabela.")
  expect(document.querySelectorAll(".message-bubble")).toHaveLength(1)
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
})

it.each([1, 3])("orders a reversed recovery chain by ancestry with retry time %s", (queuedAt) => {
  const messages = [
    message({ id: "answer", runId: "retry", text: "Pronto.", parts: [{ type: "text", text: "Pronto." }] }),
    getInterruptedMessage(),
  ]
  const runs = [
    getInterruptedRun({
      id: "retry",
      status: "succeeded",
      errorClass: null,
      queuedAt,
      automaticResumeFromRunId: "original",
    }),
    getInterruptedRun(),
  ]

  const visible = getAutomaticResumeMessages(messages, runs)
  render(<VirtualMessageList messages={messages} runs={runs} onSwitchBranch={vi.fn()} onRetry={vi.fn()} />)

  expect(visible).toHaveLength(1)
  expect(visible[0]).toMatchObject({ id: "partial", runId: "retry", status: "complete" })
  expect(visible[0]?.text).toBe("Preparei a tabela.\n\nPronto.")
  expect(visible[0]?.parts.some((part) => part.type === "notice" && part.code === "run_failed")).toBe(false)
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  expect(document.querySelectorAll('.message-bubble[data-message-id="partial"]')).toHaveLength(1)
})

it("restores visible failure controls when automatic attempts are exhausted", () => {
  render(
    <VirtualMessageList
      messages={[getInterruptedMessage()]}
      runs={[getInterruptedRun({ automaticResumePending: false })]}
      onSwitchBranch={async () => {}}
      onRetry={async () => {}}
    />,
  )

  expect(screen.getByRole("alert")).toBeInTheDocument()
  expect(screen.queryByText("Retomando automaticamente…")).not.toBeInTheDocument()
})

it("lets the person stop a task while automatic recovery is waiting", () => {
  const onCancel = vi.fn(async () => {})
  render(
    <VirtualMessageList
      messages={[getInterruptedMessage()]}
      runs={[getInterruptedRun({ automaticResumePending: true })]}
      onSwitchBranch={async () => {}}
      onRetry={async () => {}}
      onCancel={onCancel}
    />,
  )

  fireEvent.click(screen.getByRole("button", { name: "Parar" }))

  expect(onCancel).toHaveBeenCalledExactlyOnceWith("original")
})

it("leaves unrelated messages separate when another task has an automatic continuation", () => {
  const earlier = [
    message({ id: "earlier-first", runId: "earlier", text: "Primeira parte." }),
    message({ id: "earlier-second", runId: "earlier", text: "Segunda parte." }),
  ]
  const messages = [...earlier, getInterruptedMessage(), message({ id: "answer", runId: "retry", text: "Pronto." })]
  const runs = [
    getInterruptedRun({ id: "earlier", status: "succeeded", queuedAt: 0 }),
    getInterruptedRun(),
    getInterruptedRun({ id: "retry", status: "succeeded", queuedAt: 3, automaticResumeFromRunId: "original" }),
  ]

  const visible = getAutomaticResumeMessages(messages, runs)

  expect(visible.slice(0, 2)).toEqual(earlier)
  expect(visible.map((item) => item.id)).toEqual(["earlier-first", "earlier-second", "partial"])
  expect(visible[2]?.text).toBe("Preparei a tabela.\n\nPronto.")
})

it("folds a shared-channel continuation and its coordination marker into the original card", () => {
  const messages = [
    getInterruptedMessage(),
    message({
      id: "visible-marker",
      role: "system",
      kind: "notice",
      text: "Retomado após falha do provedor",
      parts: [{ type: "notice", code: "run_resumed", level: "info", text: "Retomado após falha do provedor" }],
    }),
    message({ id: "answer", runId: "retry", text: "Pronto.", parts: [{ type: "text", text: "Pronto." }] }),
  ]
  const runs = [
    getInterruptedRun(),
    getInterruptedRun({
      id: "channel-continuation",
      requestMessageId: "visible-marker",
      status: "succeeded",
      queuedAt: 3,
    }),
    getInterruptedRun({
      id: "retry",
      requestMessageId: "hidden-member-request",
      groupTurnId: "channel-continuation",
      status: "succeeded",
      queuedAt: 4,
      automaticResumeFromRunId: "original",
    }),
  ]

  const visible = getAutomaticResumeMessages(messages, runs)

  expect(visible.map((item) => item.id)).toEqual(["partial"])
  expect(visible[0]?.text).toBe("Preparei a tabela.\n\nPronto.")
})
