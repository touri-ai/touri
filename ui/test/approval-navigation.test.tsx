import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ApprovalPart, Message, RoutineRun, Run, Thread } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { openConversations, openRoutines } from "./workspaceNavigation"

const originalReveal = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView")
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  if (originalReveal) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalReveal)
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView")
})

const approval: ApprovalPart = {
  type: "approval",
  approvalId: "clock-approval",
  request: "permission",
  detail: "Bash: date +%H:%M",
  decision: "pending",
  scope: { source: "claude", tool: "Bash" },
  allowStanding: true,
}
const fixture = async () => {
  const api = createMockApi()
  const baseThread = api.getState().threads[0]
  const baseMessage = api.getState().messages[0]
  const { routines } = await api.request("GET /routines", {})
  const baseRoutine = routines[0]
  if (!baseThread || !baseMessage || !baseRoutine) throw new Error("Missing approval navigation fixture")

  const thread: Thread = {
    ...baseThread,
    id: "clock-thread",
    botId: "bot-onb",
    kind: "routine" as const,
    title: "teste-relogio",
    activeLeafId: "clock-reply",
    routineRunId: "clock-routine-run",
  }
  const reply: Message = {
    ...baseMessage,
    id: "clock-reply",
    threadId: thread.id,
    parentId: null,
    role: "assistant",
    status: "streaming",
    runId: "clock-run",
    text: "",
    parts: [approval],
    createdAt: 1,
    updatedAt: 1,
  }
  const routine = { ...baseRoutine, id: "clock-routine", botId: thread.botId, name: thread.title }
  const routineRun: RoutineRun = {
    id: "clock-routine-run",
    routineId: routine.id,
    scheduledFor: 1,
    status: "running",
    threadId: thread.id,
    runId: "clock-run",
    triggerSource: "cron",
    summary: null,
    startedAt: 1,
    finishedAt: null,
  }
  const run: Run = {
    id: "clock-run",
    botId: thread.botId,
    threadId: thread.id,
    provider: "claude",
    trigger: "routine",
    routineRunId: "clock-routine-run",
    status: "running",
    requestMessageId: null,
    replyMessageId: reply.id,
    externalTurnId: null,
    errorClass: null,
    errorMessage: null,
    usage: null,
    queuedAt: 1,
    startedAt: 1,
    finishedAt: null,
  }
  const reveal = vi.fn()
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(reveal)
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  // Real events follow a durable write; opening the conversation reloads that history.
  api.getState().threads.push(thread)
  api.getState().messages.push(reply)
  act(() => {
    api.emit({ type: "routine.updated", routine, lastRun: routineRun })
    api.emit({ type: "thread.updated", thread })
    api.emit({ type: "message.created", message: reply })
    api.emit({ type: "run.updated", run })
  })
  return { api, thread, reply, run, reveal }
}

it.each(["Cron", "notification", "sidebar", "banner"])(
  "%s opens the approval's bot and routine thread and focuses its card",
  async (source) => {
    // jsdom does not implement scrolling; record the element the UI reveals.
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} })
    const { api, reveal } = await fixture()
    if (source === "Cron") {
      openRoutines("onb")
      fireEvent.click(await screen.findByRole("button", { name: "Revisar aprovação de onb" }))
    } else if (source === "sidebar") {
      fireEvent.click(screen.getByRole("button", { name: "Revisar aprovação de onb" }))
    } else {
      act(() =>
        api.notify({
          kind: "approval",
          title: "Aprovação",
          body: "Bash: date",
          botId: "bot-onb",
          threadId: "clock-thread",
          requestId: approval.approvalId,
        }),
      )
      if (source === "banner") {
        const notice = document.querySelector(".approval-notice") as HTMLElement
        expect(notice).toHaveTextContent("pede sua aprovação: Executar comando no terminal")
        expect(notice).not.toHaveTextContent("Bash:")
        fireEvent.click(within(notice).getByRole("button", { name: "Revisar" }))
      } else {
        fireEvent.click(screen.getByRole("button", { name: /Notificações/ }))
        const row = await screen.findByTestId("notification-row")
        fireEvent.click(within(row).getByRole("button", { name: "Abrir e revisar" }))
      }
    }
    await screen.findByRole("textbox", { name: "Mensagem para onb" })
    const card = await screen.findByRole("article", { name: "Aprovação de ferramenta" })
    await waitFor(() => expect(card).toHaveFocus())
    expect(reveal.mock.contexts).toContain(card)
    expect(card).toHaveTextContent("date +%H:%M")
    const conversations = openConversations("onb")

    expect(conversations.querySelector(".thread-row.selected")).toHaveTextContent("Rotinas")
  },
)

it("a routine waits for its own pending approval, then resumes and finishes", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} })
  const { api, thread, reply, run } = await fixture()
  fireEvent.click(screen.getByRole("button", { name: /onb.*Operations/ }))
  const threadButton = within(openConversations("onb")).getByRole("button", { name: /Rotinas/ })
  fireEvent.click(threadButton)
  await screen.findByRole("heading", { name: "Rotinas", exact: true })
  const history = document.querySelector(".routine-run-history")
  if (!(history instanceof HTMLElement)) throw new Error("Missing routine history")
  fireEvent.click(await within(history).findByRole("button", { name: "Abrir conversa" }))
  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  const card = document.querySelector(".run-card")
  await waitFor(() => expect(card).toHaveTextContent("Aguardando aprovação"))
  expect(card).not.toHaveTextContent("Em execução")
  expect(card?.querySelector(".tb-typing")).toBeNull()
  act(() =>
    api.emit({ type: "message.updated", message: { ...reply, parts: [{ ...approval, decision: "approved" }] } }),
  )
  expect(card).toHaveTextContent("Em execução")
  act(() =>
    api.emit({
      type: "message.created",
      message: { ...reply, id: "unrelated-approval", runId: "another-run", parts: [approval] },
    }),
  )
  expect(card).toHaveTextContent("Em execução")
  act(() => api.emit({ type: "run.updated", run: { ...run, status: "succeeded", finishedAt: 2 } }))
  expect(card).toHaveTextContent("Concluído")
  expect(card).not.toHaveTextContent("Aguardando aprovação")
  expect(thread.botId).toBe("bot-onb")
})

it("reveals an approval outside the rendered virtual window and does not steal focus during deltas", () => {
  const reveal = vi.fn()
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: reveal })
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(200 * 158)
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400)
  const api = createMockApi()
  const base = api.getState().messages[0] as Message
  const history = Array.from(
    { length: 200 },
    (_, index): Message => ({
      ...base,
      id: `history-${index}`,
      createdAt: index,
      text: "Histórico",
      parts: index === 50 ? [approval] : [],
      parentId: null,
    }),
  )
  const props = { api, messages: history, onSwitchBranch: vi.fn(), onRetry: vi.fn() }
  const view = render(<VirtualMessageList {...props} />)
  expect(screen.queryByRole("article", { name: "Aprovação de ferramenta" })).toBeNull()
  view.rerender(<VirtualMessageList {...props} focusApproval={{ approvalId: approval.approvalId, request: 1 }} />)
  const card = screen.getByRole("article", { name: "Aprovação de ferramenta" })
  expect(card).toHaveFocus()
  expect(reveal.mock.contexts).toContain(card)
  card.querySelector("button")?.focus()
  view.rerender(
    <VirtualMessageList
      {...props}
      messages={[...history]}
      focusApproval={{ approvalId: approval.approvalId, request: 1 }}
    />,
  )
  expect(card.querySelector("button")).toHaveFocus()
  expect(reveal).toHaveBeenCalledOnce()
})
