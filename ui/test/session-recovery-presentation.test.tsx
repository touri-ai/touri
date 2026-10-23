import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { Message, MessagePart, Run } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { sessionRecoveryDiagnosticText } from "../src/components/sessionRecoveryPresentation"
import { setDocumentLanguage } from "../src/documentLanguage"
import { t } from "../src/i18n"

afterEach(() => {
  cleanup()
  setDocumentLanguage("pt-BR", document.documentElement)
})

const getDiagnostic = (): MessagePart => ({
  type: "notice",
  level: "info",
  code: "run_resumed",
  text: sessionRecoveryDiagnosticText,
})
const getMessage = (overrides: Partial<Message> = {}): Message =>
  Object.assign(
    {
      id: "reply",
      threadId: "thread",
      parentId: "marker",
      role: "assistant",
      kind: "text",
      status: "complete",
      runId: "run",
      text: "Relatório concluído.",
      parts: [{ type: "text", text: "Relatório concluído." }],
      sender: null,
      source: "local",
      createdAt: 3,
      updatedAt: 4,
    },
    overrides,
  )
const getMarker = (overrides: Partial<Message> = {}): Message =>
  getMessage(
    Object.assign(
      {
        id: "marker",
        parentId: "request",
        role: "system" as const,
        kind: "notice" as const,
        text: sessionRecoveryDiagnosticText,
        parts: [getDiagnostic()],
        createdAt: 2,
      },
      overrides,
    ),
  )
const getProvider = () => {
  const provider = createMockApi().getState().bots[0]?.provider
  if (!provider) throw new Error("Missing fixture provider")

  return provider
}
const getRun = (overrides: Partial<Run> = {}): Run =>
  Object.assign(
    {
      id: "run",
      botId: "bot",
      threadId: "thread",
      provider: getProvider(),
      trigger: "user",
      requestMessageId: "request",
      replyMessageId: "reply",
      externalTurnId: null,
      status: "succeeded",
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: null,
      queuedAt: 1,
      startedAt: 1,
      finishedAt: 4,
    },
    overrides,
  )
const getView = (messages: Message[], runs: Run[]) => (
  <VirtualMessageList messages={messages} runs={runs} onSwitchBranch={vi.fn()} onRetry={vi.fn()} />
)

it.each(["pt-BR", "en"] as const)(
  "keeps hydrated system and inline diagnostics in one existing activity disclosure in %s",
  (locale) => {
    setDocumentLanguage(locale, document.documentElement)
    const messages = [
      getMarker(),
      getMessage({
        parts: [
          { type: "reasoning", text: "Conferindo os totais." },
          getDiagnostic(),
          { type: "text", text: "Relatório concluído." },
        ],
      }),
    ]
    const persisted = JSON.stringify(messages)

    render(getView(messages, [getRun()]))

    expect(screen.queryByRole("note")).toBeNull()
    expect(screen.getByText("Relatório concluído.", { selector: "p" })).toBeVisible()
    expect(screen.getAllByRole("button", { name: /Atividade|Activity/ })).toHaveLength(1)
    const details = screen.getByRole("button", { name: /Atividade|Activity/ })
    expect(details).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText(t(sessionRecoveryDiagnosticText, {}, locale))).toBeNull()
    fireEvent.click(details)
    expect(screen.getAllByText(t(sessionRecoveryDiagnosticText, {}, locale))).toHaveLength(1)
    expect(JSON.stringify(messages)).toBe(persisted)
  },
)

it.each(["system", "inline"] as const)("folds a live %s diagnostic only after run success", (location) => {
  const reply = getMessage({
    status: "streaming",
    parts: location === "inline" ? [getDiagnostic()].concat(getMessage().parts) : getMessage().parts,
  })
  const messages = location === "system" ? [getMarker(), reply] : [reply]
  const view = render(getView(messages, [getRun({ status: "running", finishedAt: null })]))

  expect(screen.getByRole("note")).toHaveTextContent(sessionRecoveryDiagnosticText)
  view.rerender(getView(messages, [getRun()]))

  expect(screen.queryByRole("note")).toBeNull()
  expect(screen.getByText("Relatório concluído.", { selector: "p" })).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: /Atividade/ }))
  expect(screen.getByText(sessionRecoveryDiagnosticText)).toBeVisible()
})

it.each(["failed", "interrupted", "canceled"] as const)(
  "preserves the diagnostic and full text when recovery ends %s",
  (status) => {
    const reply = getMessage({
      status: status === "canceled" ? "canceled" : "failed",
      parts: [getDiagnostic()].concat(getMessage().parts),
    })

    render(getView([getMarker(), reply], [getRun({ status, errorClass: "cli_protocol" })]))

    expect(screen.getAllByRole("note")).toHaveLength(2)
    expect(screen.getByText("Relatório concluído.", { selector: "p" })).toBeVisible()
    if (status !== "canceled") expect(screen.getByRole("alert")).toBeVisible()
  },
)

it("keeps pending approvals and recovery actions visible beside resolved diagnostics", () => {
  const reply = getMessage({
    parts: [
      getDiagnostic(),
      { type: "notice", code: "run_resumed", level: "info", text: "Retomado após aprovação de acesso" },
      {
        type: "approval",
        approvalId: "approval",
        request: "command",
        decision: "pending",
        detail: "Conferir o relatório de exemplo",
      },
    ].concat(getMessage().parts),
  })

  render(getView([reply], [getRun()]))

  expect(screen.getByRole("note")).toHaveTextContent("Retomado após aprovação de acesso")
  expect(document.querySelector('[data-approval-id="approval"]')).toBeVisible()
  expect(screen.getByRole("button", { name: /Aprovar/ })).toBeVisible()
  expect(screen.getByText("Relatório concluído.", { selector: "p" })).toBeVisible()
})

it("collects diagnostics from an explicitly recovered run without hiding its text history", () => {
  const original = getRun({ id: "original", status: "interrupted", replyMessageId: "partial" })
  const recovered = getRun({ automaticResumeFromRunId: original.id })
  const partial = getMessage({
    id: "partial",
    runId: original.id,
    text: "Conferência iniciada.",
    parts: [{ type: "text", text: "Conferência iniciada." }],
  })

  render(getView([getMarker({ runId: original.id }), partial, getMessage()], [original, recovered]))

  expect(screen.queryByRole("note")).toBeNull()
  expect(screen.getByText(/Conferência iniciada/)).toBeVisible()
  expect(screen.getByText(/Relatório concluído/)).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: /Atividade/ }))
  expect(screen.getByText(sessionRecoveryDiagnosticText)).toBeVisible()
})

it("never treats an unrelated later success as resolution", () => {
  const original = getRun({ id: "original", status: "failed" })

  render(getView([getMarker({ runId: original.id }), getMessage()], [original, getRun()]))

  expect(screen.getByRole("note")).toHaveTextContent(sessionRecoveryDiagnosticText)
})

it("moves an inline ancestor diagnostic into the successful continuation details", () => {
  const original = getRun({ id: "original", status: "interrupted", replyMessageId: "partial" })
  const recovered = getRun({ automaticResumeFromRunId: original.id })
  const partial = getMessage({
    id: "partial",
    runId: original.id,
    status: "failed",
    text: "Conferência iniciada.",
    parts: [getDiagnostic(), { type: "text", text: "Conferência iniciada." }],
  })
  const messages = [partial, getMessage()]
  const persisted = JSON.stringify(messages)

  render(getView(messages, [original, recovered]))

  expect(screen.queryByText(sessionRecoveryDiagnosticText)).toBeNull()
  expect(screen.getByText(/Conferência iniciada/)).toBeVisible()
  expect(screen.getByText(/Relatório concluído/)).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: /Atividade/ }))
  expect(screen.getByText(sessionRecoveryDiagnosticText)).toBeVisible()
  expect(JSON.stringify(messages)).toBe(persisted)
})

it("keeps an inline ancestor diagnostic visible while its continuation is running", () => {
  const original = getRun({ id: "original", status: "interrupted", replyMessageId: "partial" })
  const recovered = getRun({ automaticResumeFromRunId: original.id, status: "running", finishedAt: null })
  const partial = getMessage({ id: "partial", runId: original.id, parts: [getDiagnostic()] })

  render(getView([partial, getMessage({ status: "streaming" })], [original, recovered]))

  expect(screen.getByRole("note")).toHaveTextContent(sessionRecoveryDiagnosticText)
})

it("leaves distant diagnostics visible instead of traversing growing history", () => {
  const intervening = Array.from({ length: 33 }, (_, index) =>
    getMessage({ id: `user-${index}`, role: "user", runId: null, text: `Nota ${index}`, parts: [], createdAt: 2 }),
  )

  render(getView([getMarker()].concat(intervening, getMessage()), [getRun()]))

  expect(screen.getByRole("note")).toHaveTextContent(sessionRecoveryDiagnosticText)
})

it("keeps browser diagnostics in the existing browser disclosure without an extra control", async () => {
  const reply = getMessage({
    parts: [getDiagnostic()].concat(
      [
        {
          type: "tool_call",
          callId: "browser-read",
          tool: "mcp__touri__browser_snapshot",
          summary: "Conferir a página de exemplo",
          inputJson: '{"tabId":"example-tab"}',
          outputJson: "Página conferida.",
          ok: true,
        },
      ],
      getMessage().parts,
    ),
  })

  const view = render(getView([getMarker(), reply], [getRun()]))
  const browser = await screen.findByRole("button", { name: /Usou o navegador/ })

  expect(view.container.querySelector(".turn-activity-toggle")).toBeNull()
  expect(screen.queryByRole("note")).toBeNull()
  expect(screen.getByText("Relatório concluído.", { selector: "p" })).toBeVisible()
  fireEvent.click(browser)
  expect(screen.getByText(sessionRecoveryDiagnosticText)).toBeVisible()
})
