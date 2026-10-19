import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import type { ApprovalPart, Message, NotificationRecord } from "@touri/contracts"
import { approvalSummary } from "@touri/contracts/approval-summary"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { approvalBarSummary, approvalNotificationSummary } from "../src/approvalNotice"
import { ApprovalNotice } from "../src/components/ApprovalNotice"
import { NotificationBell } from "../src/components/NotificationCenter"
import { t } from "../src/i18n"

afterEach(cleanup)

it.each([
  ["pt-BR", "Café Ideias pede sua aprovação: Executar comando no terminal"],
  ["en", "Café Ideias asks for your approval: Run a terminal command"],
] as const)("preserves the summary capitalization in %s approval copy", (locale, expected) => {
  const summary = approvalSummary({ request: "command", detail: "" }, locale)
  expect(t("{bot} pede sua aprovação: {summary}", { bot: "Café Ideias", summary: summary.body }, locale)).toBe(expected)
})

const folder: ApprovalPart = {
  type: "approval",
  approvalId: "folder-approval",
  request: "permission",
  decision: "pending",
  scope: { source: "mcp", server: "touri", tool: "folder_access_request" },
  detail:
    'folder_access_request: {"path":"/workspace/phase-a","requestedPath":"/workspace/alias","mode":"read-write","previousMode":null,"nextTurn":false}',
}
const notification: NotificationRecord = {
  id: 1,
  kind: "approval",
  level: "warning",
  botId: "bot-a",
  botName: "Café Ideias",
  botColor: "#cc3355",
  avatarShape: "classic-none",
  threadId: "thread-a",
  requestId: folder.approvalId,
  title: "Approve action",
  body: folder.detail,
  createdAt: 1,
  resolvedAt: null,
  resolution: null,
}
const message = (part: ApprovalPart): Message => ({
  id: "reply-a",
  threadId: "thread-a",
  parentId: null,
  role: "assistant",
  kind: "tool",
  status: "streaming",
  runId: null,
  text: "",
  parts: [part],
  sender: null,
  source: "local",
  createdAt: 1,
  updatedAt: 1,
})

it.each(["pt-BR", "en"] as const)("keeps full folder details in %s outside the compact bar", (locale) => {
  const summary = approvalSummary(
    {
      ...folder,
      detail: JSON.stringify({
        path: "/workspace/reports/phase a/",
        mode: "read-write",
        nextTurn: true,
        machine: "local",
        writeApproval: true,
        createPath: "/workspace/reports/phase a/images",
      }),
    },
    locale,
  )
  const compact = approvalBarSummary(summary)
  expect(compact.title).toContain("…/phase a")
  expect(compact.body).toContain("…/phase a")
  expect(`${compact.title} ${compact.body}`).not.toContain("/workspace")
  expect(compact.body).not.toMatch(/próximo turno|next local turn|images/)
  expect(summary.body).toContain("/workspace/reports/phase a/images")
})

it("does not trust technical prefixes in stored notification titles", () => {
  const summary = approvalNotificationSummary(
    { ...notification, title: "internal_tool: Terminal", body: 'Bash: {"command":"printf marker"}' },
    [],
  )
  expect(summary.title).toBe("Terminal")
  expect(summary.body).toBe("Executar comando no terminal")
  expect(`${summary.title} ${summary.body}`).not.toMatch(/internal_tool|Bash|printf|[{}]/)
})

it("uses the card's canonical summary for legacy and current folder notifications", () => {
  const summary = "Permitir Leitura e escrita em …/phase-a para este bot."
  const props = { notifications: [notification], messages: [message(folder)], onReview: vi.fn() }
  const view = render(<ApprovalNotice {...props} />)
  const notice = screen.getByRole("status")
  expect(notice.querySelector(".notice-content")).toHaveTextContent(
    "Café Ideias pede sua aprovação: Permitir Leitura e escrita em …/phase-a para este bot.",
  )
  expect(notice).not.toHaveTextContent("..")
  expect(notice).toHaveTextContent(summary)
  expect(notice).not.toHaveTextContent(/folder_access_request|requestedPath|previousMode|nextTurn|[{}]/)
  fireEvent.click(within(notice).getByRole("button", { name: "Revisar" }))
  expect(props.onReview).toHaveBeenCalledWith({ threadId: "thread-a", approvalId: folder.approvalId })
  view.rerender(
    <ApprovalNotice {...props} notifications={[{ ...notification, ...approvalSummary(folder) }]} messages={[]} />,
  )
  expect(screen.getByRole("status")).toHaveTextContent(summary)
})

it("dismisses only the reminder, keeps approval pending, and shows the next request", () => {
  const props = { notifications: [notification], messages: [], onReview: vi.fn() }
  const view = render(<ApprovalNotice {...props} />)
  fireEvent.click(screen.getByRole("button", { name: "Dispensar aviso" }))
  expect(screen.queryByRole("status")).toBeNull()
  expect(notification.resolution).toBeNull()
  view.rerender(
    <ApprovalNotice {...props} notifications={[notification, { ...notification, id: 2, requestId: "next-request" }]} />,
  )
  expect(screen.getByRole("status")).toBeInTheDocument()
})

it.each(["approved", "denied", "expired"] as const)(
  "removes a resolved approval reminder via message: %s",
  (decision) => {
    render(
      <ApprovalNotice
        notifications={[notification]}
        messages={[message({ ...folder, decision, resolvedAt: 2 })]}
        onReview={vi.fn()}
      />,
    )
    expect(screen.queryByRole("status")).toBeNull()
  },
)

it.each([true, false])("keeps technical details collapsed in the notification center (card loaded: %s)", (loaded) => {
  const open = vi.fn()
  render(
    <NotificationBell
      notifications={[notification]}
      messages={loaded ? [message(folder)] : []}
      actions={{ open, dismiss: vi.fn(), dismissAll: vi.fn(), respond: vi.fn(), reply: vi.fn() }}
    />,
  )
  fireEvent.click(screen.getByRole("button", { name: /Notificações/ }))
  const row = screen.getByTestId("notification-row")
  expect(row.querySelector(".notification-title")).toHaveTextContent("Conceder acesso à pasta")
  expect(row.querySelector(".notification-body")).toHaveTextContent(
    "Permitir Leitura e escrita em /workspace/phase-a para este bot",
  )
  const technical = within(row).getByText("Detalhes técnicos").closest("details")
  expect(technical).not.toHaveAttribute("open")
  expect(technical?.querySelector("pre")).toHaveTextContent("folder_access_request")
  fireEvent.click(within(row).getByRole("button", { name: "Revisar" }))
  expect(open).toHaveBeenCalledWith(notification)
})

it("does not duplicate headless approval echoes as generic notices", async () => {
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  act(() => {
    const item = api.notify({ ...notification, botId: "bot-mark", threadId: "thread-mark-main" })
    api.emit({
      type: "notify",
      level: "warning",
      title: `Café Ideias: ${item.title}`,
      body: item.body,
      threadId: item.threadId,
    })
  })
  expect(document.querySelector(".notice-bar:not(.approval-notice)")).toBeNull()
  expect(document.querySelector(".approval-notice")).not.toHaveTextContent("folder_access_request")
  const panel = screen.getByRole("button", { name: /Painel do bot/ })
  fireEvent.click(panel)
  expect(panel).toHaveAttribute("aria-expanded", "true")
})

it.each(["allow", "deny", "expired"] as const)(
  "clears a write-access notice after %s without dismissing it",
  async (resolution) => {
    const api = createMockApi()
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    const part: ApprovalPart = {
      ...folder,
      detail: JSON.stringify({
        path: "/workspace/reports/phase a",
        createPath: "/workspace/reports/phase a/images",
        mode: "read-write",
        writeApproval: true,
        nextTurn: true,
        machine: "local",
      }),
    }
    let item = notification
    act(() => {
      item = api.notify({ ...notification, botId: "bot-mark", threadId: "thread-mark-main", ...approvalSummary(part) })
      api.emit({
        type: "notify",
        level: "warning",
        title: `Café Ideias: ${item.title}`,
        body: item.body,
        threadId: item.threadId,
      })
    })
    expect(document.querySelector(".notice-bar:not(.approval-notice)")).toBeNull()
    const notice = document.querySelector(".approval-notice")
    expect(notice).toHaveTextContent("pede sua aprovação: Permitir Leitura e escrita em …/phase a para este bot.")
    expect(notice).not.toHaveTextContent("/workspace")
    expect(notice).not.toHaveTextContent("será criada automaticamente")
    act(() => api.emit({ type: "notification.resolved", notification: { ...item, resolution, resolvedAt: 2 } }))
    if (resolution === "allow")
      expect(document.querySelector(".approval-notice")).toHaveTextContent("Autorizado. Retomando a tarefa.")
    else expect(document.querySelector(".notice-bar")).toBeNull()
  },
)
