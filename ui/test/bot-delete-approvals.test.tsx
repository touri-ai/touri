import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ApprovalPart, Message, NotificationRecord, StandingGrant } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { reconcileApprovalMessages, reconcileApprovalNotifications } from "../src/approvalState"
import { latestPreview } from "../src/botPreview"
import { ApprovalCard } from "../src/components/ApprovalCard"
import { DeleteBotDialog } from "../src/components/DeleteBotDialog"
import { mascotSignalFor } from "../src/components/mascotState"
import { NotificationBell } from "../src/components/NotificationCenter"
import { pendingNotifications } from "../src/sidebarAttention"
import { updateMessage } from "../src/useWorkspace"
import { showBotSettings } from "./workspaceNavigation"

afterEach(() => {
  cleanup()
  localStorage.clear()
  window.history.replaceState(null, "", "/")
})

it("A11 deletion dialog describes replay, attachments, memory, skills, login and preserved projects", () => {
  const bot = createMockApi().getState().bots[0]
  if (!bot) throw new Error("Missing fixture bot")
  render(<DeleteBotDialog bot={bot} onDelete={vi.fn()} onClose={vi.fn()} />)
  const dialog = screen.getByRole("dialog", { name: "Excluir bot" })
  for (const scope of [/reconexão/, /anexos/i, /MEMORY/, /skills/, /cofre/, /projetos.*preservados/i])
    expect(dialog).toHaveTextContent(scope)
})
const approval: ApprovalPart = {
  type: "approval",
  approvalId: "request",
  botId: "bot-mark",
  request: "permission",
  detail: "Bash: pwd",
  decision: "pending",
  allowStanding: true,
  scope: { source: "claude", tool: "Bash" },
}
const notice = (patch: Partial<NotificationRecord> = {}): NotificationRecord => ({
  id: 42,
  botId: "bot-mark",
  botName: "mark",
  botColor: "#abc",
  avatarShape: "classic-none",
  threadId: "thread-mark",
  kind: "approval",
  level: "warning",
  title: "Approve action",
  body: "Bash: pwd",
  requestId: "request",
  createdAt: 100,
  resolvedAt: null,
  resolution: null,
  ...patch,
})
const message = (part = approval): Message =>
  ({
    ...createMockApi().getState().messages[0],
    id: "approval-message",
    role: "assistant",
    threadId: "thread-mark",
    status: "streaming",
    text: "",
    parts: [part],
    createdAt: 100,
    updatedAt: 200,
  }) as Message

it("requires the exact bot name and keeps computer files by default", async () => {
  const bot = createMockApi().getState().bots[0]
  if (!bot) throw new Error("Bot ausente")
  const remove = vi.fn().mockResolvedValue(undefined)
  render(<DeleteBotDialog bot={{ ...bot, machine: "vm" }} onDelete={remove} onClose={vi.fn()} />)
  const confirm = screen.getByRole("button", { name: "Excluir bot" })
  expect(confirm).toBeDisabled()
  const name = screen.getByLabelText(`Digite o nome do bot: ${bot.name}`)
  fireEvent.change(name, { target: { value: `${bot.name} ` } })
  expect(confirm).toBeDisabled()
  fireEvent.change(name, { target: { value: bot.name } })
  expect(screen.getByRole("checkbox", { name: "apagar também os arquivos do computador" })).not.toBeChecked()
  fireEvent.keyDown(name, { key: "Enter" })
  expect(remove).not.toHaveBeenCalled()
  fireEvent.click(confirm)
  await waitFor(() => expect(remove).toHaveBeenCalledWith(bot.id, bot.name, false))
})

for (const entry of ["settings", "context"] as const)
  it(`deletes from ${entry} and leaves the other bots intact`, async () => {
    const api = createMockApi()
    const original = api.getState().bots.map((bot) => bot.id)
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    if (entry === "settings") {
      showBotSettings()
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }),
      )
      fireEvent.click(screen.getByRole("button", { name: "Excluir bot" }))
    } else {
      const sidebar = screen.getByRole("navigation", { name: "Barra lateral" })
      fireEvent.contextMenu(sidebar.querySelector('[data-bot-entry="bot-mark"] .bot-row-main') as HTMLElement)
      fireEvent.click(screen.getByRole("menuitem", { name: "Excluir bot" }))
    }
    const dialog = screen.getByRole("dialog", { name: "Excluir bot" })
    fireEvent.change(within(dialog).getByLabelText("Digite o nome do bot: mark"), { target: { value: "mark" } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Excluir bot" }))
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Excluir bot" })).toBeNull())
    expect(api.getState().bots.map((bot) => bot.id)).toEqual(original.filter((id) => id !== "bot-mark"))
    expect(api.getState().threads.some((thread) => thread.botId === "bot-mark")).toBe(false)
  })

it("confirms the tool scope before granting a permanent permission and offers revoke", async () => {
  const api = createMockApi()
  const grant: StandingGrant = {
    id: "grant",
    botId: "bot-mark",
    scope: { source: "claude", tool: "Bash" },
    grantedAt: 200,
  }
  const request = vi.fn(async (route: string) => (route === "GET /bots/:id/grants" ? { grants: [grant] } : {}))
  api.request = request as ApiRequest
  render(<ApprovalCard api={api} part={approval} />)
  const user = userEvent.setup()
  screen.getByRole("button", { name: "Permitir sempre nesta ferramenta" }).focus()
  await user.keyboard("{Enter}")
  expect(request).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Permitir sempre nesta ferramenta" }))
  expect(screen.getByText(/A ferramenta Terminal poderá agir neste bot/)).toHaveTextContent(
    "inclusive em novas chamadas com outros parâmetros",
  )
  expect(screen.getByText(/Avançado → Permissões/)).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: /Sim, permitir .* neste bot sem perguntar de novo/ }))
  await screen.findByText("Permissão permanente neste bot")
  expect(document.querySelector('[data-approval-scope="standing"]')).toHaveClass("approval-standing")
  expect(screen.getByRole("button", { name: "Revogar" }).closest(".tool-revoke-action")).not.toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Revogar" }))
  await screen.findByText("Permissão permanente revogada.")
  expect(request).toHaveBeenCalledWith("DELETE /bots/:id/grants/:grant", {}, { id: "bot-mark", grant: "grant" })
})

for (const decision of ["approved", "denied"] as const)
  it(`resolved ${decision} is reconciled across cards, notifications and previews`, async () => {
    const resolved = { ...approval, decision, resolvedAt: 200 }
    const messages = [message(resolved)]
    const records = reconcileApprovalNotifications([notice()], messages)
    expect(records[0]?.resolvedAt).toBe(200)
    const synced = reconcileApprovalMessages([message()], records)
    expect(synced[0]?.parts[0]).toMatchObject({ decision, resolvedAt: 200 })
    const label = decision === "approved" ? "Aprovado por você" : "Negado por você"
    expect(latestPreview({ threadIds: ["thread-mark"], messages: synced })).toContain(`${label} ·`)
    render(
      <>
        <ApprovalCard api={createMockApi()} part={resolved} />
        <NotificationBell
          notifications={[notice()]}
          messages={messages}
          actions={{ open: vi.fn(), dismiss: vi.fn(), dismissAll: vi.fn(), respond: vi.fn(), reply: vi.fn() }}
        />
      </>,
    )
    fireEvent.click(screen.getByRole("button", { name: "Notificações" }))
    expect(screen.queryByText("Aprovar ação")).toBeNull()
    expect(screen.queryByRole("button", { name: "Aprovar" })).toBeNull()
    expect(screen.getAllByText(label)).toHaveLength(2)
    expect(document.querySelectorAll("time").length).toBeGreaterThan(1)
    expect(updateMessage(messages, message())[0]?.parts[0]).toMatchObject({ decision })
  })

for (const decision of ["approved", "denied", "expired"] as const)
  it(`restores ${decision} across cards, notifications and previews without inventing a resolution time`, () => {
    const messages = [message({ ...approval, decision })]
    const records = reconcileApprovalNotifications([notice()], messages)
    expect(records[0]?.resolvedAt).toBeNull()
    expect(pendingNotifications(records, messages)).toEqual([])
    expect(mascotSignalFor({ botId: "bot-mark", notifications: records, messages }).state).not.toBe("waiting-approval")
    const synced = reconcileApprovalMessages([message()], records)
    expect(synced[0]?.parts[0]).toMatchObject({ decision })
    expect(synced[0]?.parts[0]).not.toHaveProperty("resolvedAt")
    const label =
      decision === "approved" ? "Aprovado por você" : decision === "denied" ? "Negado por você" : "Aprovação expirada"
    expect(latestPreview({ threadIds: ["thread-mark"], messages: synced })).toBe(label)
    const view = render(
      <>
        <ApprovalCard api={createMockApi()} part={{ ...approval, decision }} createdAt={100} />
        <NotificationBell
          notifications={[notice()]}
          messages={messages}
          actions={{ open: vi.fn(), dismiss: vi.fn(), dismissAll: vi.fn(), respond: vi.fn(), reply: vi.fn() }}
        />
      </>,
    )
    fireEvent.click(screen.getByRole("button", { name: "Notificações" }))
    expect(screen.queryByRole("button", { name: "Aprovar" })).toBeNull()
    expect(screen.getAllByText(label)).toHaveLength(2)
    expect(view.container.querySelector(".tool-decision-chip time")).toBeNull()
    if (decision !== "approved") expect(view.container.querySelector(".tool-status-chip time")).toBeNull()
    expect(screen.getByTestId("notification-row").querySelectorAll("time")).toHaveLength(1)
  })

it("a pending failure in another conversation shows the same request in the bot row and bell", async () => {
  const api = createMockApi()
  const newer = api.getState().messages.find((row) => row.role === "assistant" && row.threadId === "thread-mark")
  if (!newer) throw new Error("Mensagem ausente")
  newer.createdAt = Date.now() + 2000
  newer.updatedAt = newer.createdAt
  newer.text = "Trabalho concluído agora"
  newer.status = "complete"
  newer.parts = [{ type: "text", text: newer.text }]
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  act(() => {
    api.notify({
      kind: "turn-failed",
      botId: "bot-mark",
      threadId: "old-thread",
      title: "Turn failed",
      body: "Falha antiga",
    })
  })
  await waitFor(() =>
    expect(document.querySelector('[data-bot-entry="bot-mark"] .bot-preview')).toHaveTextContent(
      "Aguardando você: revise a tarefa interrompida",
    ),
  )
  expect(screen.getByRole("button", { name: "Notificações, 1 precisa de atenção" })).toBeVisible()
})
