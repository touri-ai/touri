import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ApprovalPart, Bot, McpServer, StandingGrant } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { ApprovalCard } from "../src/components/ApprovalCard"
import { BotMcpSettings } from "../src/components/BotMcpSettings"
import { BotStandingGrants } from "../src/components/BotStandingGrants"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { BotCreateModal, BotSettingsModal } from "../src/components/Modals"
import { t } from "../src/i18n"
import type { WorkspaceActions } from "../src/useWorkspace"

afterEach(cleanup)
const part: ApprovalPart = {
  type: "approval",
  approvalId: "approval",
  request: "permission",
  detail: "Salvar documento",
  decision: "pending",
  scope: { source: "mcp", server: "docs", tool: "save" },
  allowStanding: true,
}

for (const [label, decision] of [
  ["Aprovar", "approved"],
  ["Negar", "denied"],
] as const) {
  it(`approval card sends ${label} and settles visibly`, async () => {
    const api = createMockApi()
    render(<ApprovalCard api={api} part={part} />)
    fireEvent.click(screen.getByRole("button", { name: label }))
    await waitFor(() =>
      expect(api.calls).toContainEqual({
        route: "POST /approvals/:id",
        input: { decision, standing: false },
        pathValues: { id: "approval" },
      }),
    )
    await screen.findByText(decision === "approved" ? "Aprovado por você" : "Negado por você")
    expect(screen.queryByRole("button", { name: "Aprovar" })).toBeNull()
  })
}

it("requires a scoped confirmation before granting standing permission", async () => {
  const api = createMockApi()
  render(<ApprovalCard api={api} part={part} />)

  fireEvent.click(screen.getByRole("button", { name: "Permitir sempre nesta ferramenta" }))
  expect(screen.getByRole("group", { name: /Permissão permanente para/ })).toBeVisible()
  expect(screen.getByText(/novas chamadas com outros parâmetros/)).toBeVisible()
  expect(screen.getByText(/Avançado → Permissões/)).toBeVisible()
  expect(api.calls).toEqual([])

  fireEvent.click(screen.getByRole("button", { name: "Voltar" }))
  expect(screen.getByRole("button", { name: "Permitir sempre nesta ferramenta" })).toBeVisible()
  expect(api.calls).toEqual([])

  fireEvent.click(screen.getByRole("button", { name: "Permitir sempre nesta ferramenta" }))
  fireEvent.click(screen.getByRole("button", { name: /Sim, permitir .* neste bot sem perguntar de novo/ }))
  await waitFor(() =>
    expect(api.calls).toContainEqual({
      route: "POST /approvals/:id",
      input: { decision: "approved", standing: true },
      pathValues: { id: "approval" },
    }),
  )
  await screen.findByText("Permissão permanente neste bot")
})

it("does not deny a pending approval when Escape is pressed on its card", () => {
  const api = createMockApi()
  render(<ApprovalCard api={api} part={part} />)

  fireEvent.keyDown(document.querySelector('[data-approval-id="approval"]') as HTMLElement, { key: "Escape" })

  expect(api.calls).toEqual([])
  expect(screen.getByRole("button", { name: "Aprovar" })).toBeVisible()
})

it("shows the standing permission confirmation in English too", () => {
  expect(t("Permitir sempre nesta ferramenta", {}, "en")).toBe("Always allow this tool")
  expect(
    t(
      "A ferramenta {name} poderá agir neste bot sem pedir aprovação novamente, inclusive em novas chamadas com outros parâmetros. Você pode remover essa permissão em Avançado → Permissões.",
      { name: "save" },
      "en",
    ),
  ).toContain("Advanced → Permissions")
  expect(t("Sim, permitir {name} neste bot sem perguntar de novo", { name: "save" }, "en")).toBe(
    "Yes, allow save on this bot without asking again",
  )
})

it("permission cards show failed responses and hide standing approval for questions", async () => {
  const api = createMockApi()
  api.request = vi.fn(async () => {
    throw new Error("Falha de conexão")
  }) as ApiRequest
  render(<ApprovalCard api={api} part={{ ...part, allowStanding: false }} />)
  expect(screen.queryByRole("button", { name: "Permitir sempre nesta ferramenta" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Aprovar" }))
  await screen.findByRole("alert")
  expect(screen.getByRole("button", { name: "Negar" })).toBeEnabled()
})

it("MCP classification and policy edits save the selected tool for this bot", async () => {
  const api = createMockApi()
  let server: McpServer = {
    name: "docs",
    transport: "http",
    url: "https://example.test/mcp",
    tools: [{ name: "save", description: "Salvar", classification: "writes", policy: "needs_approval" }],
  }
  const request = vi.fn(async (route: string, input: unknown) => {
    if (route === "GET /bots/:id/mcp") return { servers: [server] }
    server = { ...server, tools: [{ ...server.tools[0], ...(input as object) }] } as McpServer
    return { server }
  })
  api.request = request as ApiRequest
  render(<BotMcpSettings api={api} botId="bot-a" />)
  fireEvent.click(await screen.findByRole("button", { name: "Configuração técnica (MCP)" }))
  const policy = await screen.findByRole("combobox", { name: "Política · save" })
  fireEvent.change(policy, { target: { value: "blocked" } })
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "PATCH /bots/:id/mcp/:name/tools/:tool",
      { classification: "writes", policy: "blocked" },
      { id: "bot-a", name: "docs", tool: "save" },
    ),
  )
  await waitFor(() => expect(policy).toBeEnabled())
  fireEvent.change(screen.getByRole("combobox", { name: "Classificação · save" }), { target: { value: "reads" } })
  await waitFor(() =>
    expect(request).toHaveBeenLastCalledWith(
      "PATCH /bots/:id/mcp/:name/tools/:tool",
      { classification: "reads", policy: "blocked" },
      { id: "bot-a", name: "docs", tool: "save" },
    ),
  )
})

it("standing grants are listed and can be revoked in bot permissions", async () => {
  const api = createMockApi()
  const grants: StandingGrant[] = [
    { id: "grant-a", botId: "bot-a", scope: { source: "mcp", server: "docs", tool: "save" }, grantedAt: 1 },
  ]
  const request = vi.fn(async (route: string) => (route.startsWith("GET") ? { grants } : {}))
  api.request = request as ApiRequest
  render(<BotStandingGrants api={api} botId="bot-a" />)
  await screen.findByText("docs · save")
  fireEvent.click(screen.getByRole("button", { name: "Revogar" }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("DELETE /bots/:id/grants/:grant", {}, { id: "bot-a", grant: "grant-a" }),
  )
  await screen.findByText("Nenhuma permissão permanente concedida.")
})

it("approval cards appear in chat messages and react to settled parts", async () => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Missing bot")
  const message = {
    ...api.getState().messages[0],
    id: "approval-message",
    threadId: bot.mainThreadId ?? "thread",
    role: "assistant" as const,
    text: "",
    parts: [part],
    createdAt: 1,
  } as import("@touri/contracts").Message
  const props = { api, messages: [message], onSwitchBranch: vi.fn(), onRetry: vi.fn() }
  const view = render(<VirtualMessageList {...props} />)
  expect(screen.getByRole("button", { name: "Permitir sempre nesta ferramenta" })).toBeVisible()
  view.rerender(
    <VirtualMessageList {...props} messages={[{ ...message, parts: [{ ...part, decision: "expired" }] }]} />,
  )
  await screen.findByText("Aprovação expirada")
  expect(screen.queryByRole("button", { name: "Aprovar" })).toBeNull()
})

it("MCP policy changes refresh standing grants in the permissions modal", async () => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Missing bot")
  const server: McpServer = {
    name: "docs",
    transport: "http",
    url: "https://example.test/mcp",
    tools: [{ name: "save", description: "Salvar", classification: "writes", policy: "needs_approval" }],
  }
  let grants: StandingGrant[] = [
    { id: "grant", botId: bot.id, scope: { source: "mcp", server: "docs", tool: "save" }, grantedAt: 1 },
  ]
  api.request = vi.fn(async (route: string, input: unknown) => {
    if (route === "GET /bots/:id/grants") return { grants }
    if (route === "GET /bots/:id/mcp") return { servers: [server] }
    if (route === "PATCH /bots/:id/mcp/:name/tools/:tool") {
      grants = []
      return { server: { ...server, tools: [{ ...server.tools[0], ...(input as object) }] } }
    }
    return {}
  }) as ApiRequest
  render(
    <BotSettingsModal
      bot={bot}
      api={api}
      projects={[]}
      routines={[]}
      actions={{ updateBot: vi.fn() } as unknown as WorkspaceActions}
      onClose={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.click(screen.getByRole("tab", { name: "Permissões" }))
  await screen.findByText("docs · save")
  fireEvent.click(screen.getByRole("tab", { name: "Ferramentas" }))
  fireEvent.click(await screen.findByRole("button", { name: "Configuração técnica (MCP)" }))
  fireEvent.change(await screen.findByRole("combobox", { name: "Política · save" }), { target: { value: "blocked" } })
  fireEvent.click(screen.getByRole("tab", { name: "Permissões" }))
  await screen.findByText("Nenhuma permissão permanente concedida.")
  expect(screen.queryByRole("button", { name: "Revogar" })).toBeNull()
})

it("Codex creation hides full access with approval and explains sandbox behavior", () => {
  render(<BotCreateModal onClose={vi.fn()} onCreate={vi.fn()} />)
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Teste" } })
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  expect(screen.queryByRole("option", { name: "Acesso total com aprovação" })).toBeNull()
  fireEvent.change(screen.getByLabelText("Acesso", { selector: "select" }), { target: { value: "full" } })
  const warning = screen.getByText(/O acesso total permite ler, criar, alterar e apagar arquivos/)
  expect(warning).toHaveTextContent("As pastas e exclusões salvas não limitam este acesso.")
  expect(warning).toHaveTextContent("Não pede aprovações do provedor.")
  expect(screen.getByRole("option", { name: "Somente leitura" })).toBeVisible()
})

it("switching a Claude bot with full approved access to Codex saves full access with never approvals", async () => {
  const api = createMockApi()
  const base = api.getState().bots[0]
  if (!base) throw new Error("Bot da fixture ausente")
  const bot: Bot = { ...base, provider: "claude", access: "full", approvals: "on-request" }
  const updateBot = vi.fn(async () => undefined)
  render(
    <BotSettingsModal
      bot={bot}
      projects={[]}
      routines={[]}
      actions={{ updateBot } as unknown as WorkspaceActions}
      onClose={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.click(screen.getByRole("tab", { name: "Acesso" }))
  expect(screen.getByRole("option", { name: "Acesso total com aprovação" })).toBeVisible()
  fireEvent.click(screen.getByRole("tab", { name: "Modelo" }))
  fireEvent.change(screen.getByRole("combobox", { name: "Provedor" }), { target: { value: "codex" } })
  expect(screen.queryByRole("option", { name: "Acesso total com aprovação" })).toBeNull()
  fireEvent.click(screen.getByRole("tab", { name: "Acesso" }))
  expect(screen.getByRole("combobox", { name: "Acesso" })).toHaveValue("full")
  fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }))
  await waitFor(() =>
    expect(updateBot).toHaveBeenCalledWith(
      bot.id,
      expect.objectContaining({ provider: "codex", access: "full", approvals: "never" }),
    ),
  )
})
