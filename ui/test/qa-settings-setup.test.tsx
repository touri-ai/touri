import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ApprovalPart, ToolCallPart } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createApiClient } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { BotMcpSettings } from "../src/components/BotMcpSettings"
import { BotSettingsModal } from "../src/components/Modals"
import { ToolCallCard } from "../src/components/ToolCallCard"
import { ToolCallList } from "../src/components/ToolCallList"
import { approvalMatchesTool } from "../src/components/toolPresentation"
import type { WorkspaceActions } from "../src/useWorkspace"

afterEach(cleanup)

it.each(["não é json", "[", "{}", "[42]"])("F024: explains invalid MCP JSON %s without sending it", async (value) => {
  const user = userEvent.setup()
  const api = createMockApi()
  render(<BotMcpSettings api={api} botId="json-bot" />)
  fireEvent.click(screen.getByRole("button", { name: "Configuração técnica (MCP)" }))
  fireEvent.change(screen.getByLabelText("Nome do servidor MCP"), { target: { value: "test" } })
  fireEvent.change(screen.getByLabelText("Comando MCP"), { target: { value: "node" } })
  const args = screen.getByLabelText("Argumentos MCP (lista JSON)")
  fireEvent.change(args, { target: { value } })
  expect(args).toHaveAttribute("aria-invalid", "true")
  expect(args).toHaveAccessibleDescription('Informe uma lista JSON de textos. Exemplo: ["--porta", "3000"] ou [].')
  args.focus()
  await user.keyboard("{Tab}{Enter}{Enter}")
  expect(api.calls.some((call) => call.route === "PUT /bots/:id/mcp/:name")).toBe(false)
  expect(screen.queryByText(/JSON Parse error|Unexpected/)).toBeNull()
  fireEvent.change(args, { target: { value: ' ["--porta", "3000"] ' } })
  expect(args).toHaveAttribute("aria-invalid", "false")
  expect(screen.getByRole("button", { name: "Testar conexão" })).toBeEnabled()
})

it("F025: shows the missing MCP command through the real API error boundary and allows retry", async () => {
  const user = userEvent.setup()
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "POST"
      ? Response.json({ errorCode: "MCP_EXECUTABLE_NOT_FOUND", code: "TOURI-E1012" }, { status: 400 })
      : Response.json({ servers: [] }),
  )
  const api = createApiClient({ endpoint: { baseUrl: "", wsUrl: "", token: "" }, fetchImpl })
  render(<BotMcpSettings api={api} botId="missing-command" />)
  fireEvent.click(screen.getByRole("button", { name: "Configuração técnica (MCP)" }))
  fireEvent.change(screen.getByLabelText("Nome do servidor MCP"), { target: { value: "qa-command" } })
  fireEvent.change(screen.getByLabelText("Comando MCP"), { target: { value: "touri-qa-command-does-not-exist" } })
  for (let i = 0; i < 2; i++) {
    await user.click(screen.getByRole("button", { name: "Testar conexão" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/touri-qa-command-does-not-exist.*não foi encontrado/)
    expect(screen.getByRole("alert")).toHaveTextContent(/máquina deste bot/)
    expect(screen.getByLabelText("Comando MCP")).toHaveAttribute("aria-invalid", "true")
  }
  expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2)
})

it("F025: identifies an invalid server name before attempting a connection", async () => {
  const api = createMockApi()
  render(<BotMcpSettings api={api} botId="bad-name" />)
  fireEvent.click(screen.getByRole("button", { name: "Configuração técnica (MCP)" }))
  fireEvent.change(screen.getByLabelText("Nome do servidor MCP"), { target: { value: "QA comando inexistente" } })
  fireEvent.change(screen.getByLabelText("Comando MCP"), { target: { value: "touri-qa-command-does-not-exist" } })
  expect(screen.getByLabelText("Nome do servidor MCP")).toHaveAttribute("aria-invalid", "true")
  expect(screen.getByLabelText("Nome do servidor MCP")).toHaveAccessibleDescription(/começando por uma letra/)
  expect(screen.getByRole("button", { name: "Conectar servidor MCP" })).toBeDisabled()
  expect(api.calls.some((call) => call.route === "PUT /bots/:id/mcp/:name")).toBe(false)
})

it("F005: requires an absolute folder before connecting the local-files preset", async () => {
  const api = createMockApi()
  const request = vi.fn(async (route, input) =>
    route === "GET /bots/:id/mcp"
      ? { servers: [] }
      : { server: { ...input, tools: [{ name: "list_files", description: "" }] } },
  ) as ApiRequest
  render(<BotMcpSettings api={{ ...api, request }} botId="files-bot" />)
  fireEvent.click(screen.getByRole("button", { name: "Configuração técnica (MCP)" }))
  fireEvent.change(screen.getByLabelText("Nome do servidor MCP"), { target: { value: "arquivos" } })
  fireEvent.change(screen.getByLabelText("Comando MCP"), { target: { value: "npx" } })
  fireEvent.change(screen.getByLabelText("Argumentos MCP (lista JSON)"), {
    target: { value: '["-y","@modelcontextprotocol/server-filesystem"]' },
  })
  const connect = screen.getByRole("button", { name: "Testar conexão" })
  expect(connect).toBeDisabled()
  const folder = screen.getByRole("textbox", { name: "Pasta permitida (caminho absoluto)" })
  expect(folder).toBeRequired()
  fireEvent.change(folder, { target: { value: "relative/folder" } })
  expect(connect).toBeDisabled()
  fireEvent.click(connect)
  expect(request).not.toHaveBeenCalledWith("PUT /bots/:id/mcp/:name", expect.anything(), expect.anything())
  fireEvent.change(folder, { target: { value: "/workspace/Meus arquivos" } })
  expect(connect).toBeEnabled()
  fireEvent.click(connect)
  await waitFor(() => expect(screen.getByRole("button", { name: "Conectar servidor MCP" })).toBeEnabled())
  fireEvent.click(screen.getByRole("button", { name: "Conectar servidor MCP" }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "PUT /bots/:id/mcp/:name",
      {
        name: "arquivos",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace/Meus arquivos"],
        tools: [],
      },
      { id: "files-bot", name: "arquivos" },
    ),
  )
})

it("F005: validates edited JSON too and does not require a folder for Gmail or HTTP", async () => {
  render(<BotMcpSettings api={createMockApi()} botId="files-bot" />)
  fireEvent.click(screen.getByRole("button", { name: "Configuração técnica (MCP)" }))
  fireEvent.change(screen.getByLabelText("Nome do servidor MCP"), { target: { value: "arquivos" } })
  fireEvent.change(screen.getByLabelText("Comando MCP"), { target: { value: "npx" } })
  fireEvent.change(screen.getByLabelText("Argumentos MCP (lista JSON)"), {
    target: { value: '["-y","@modelcontextprotocol/server-filesystem"]' },
  })
  const connect = screen.getByRole("button", { name: "Testar conexão" })
  const args = screen.getByLabelText("Argumentos MCP (lista JSON)")
  for (const value of ["[", "{}", "[42]", '["-y","@modelcontextprotocol/server-filesystem","relative"]']) {
    fireEvent.change(args, { target: { value } })
    expect(connect).toBeDisabled()
  }
  fireEvent.change(args, {
    target: { value: '["-y","@modelcontextprotocol/server-filesystem","/workspace/Documents"]' },
  })
  expect(connect).toBeEnabled()
  expect(screen.getByLabelText("Pasta permitida (caminho absoluto)")).toHaveValue("/workspace/Documents")
  fireEvent.change(args, { target: { value: '["-y","@shinzolabs/gmail-mcp"]' } })
  expect(connect).toBeEnabled()
  expect(screen.queryByLabelText("Pasta permitida (caminho absoluto)")).toBeNull()
  fireEvent.change(screen.getByLabelText("Argumentos MCP (lista JSON)"), { target: { value: "[" } })
  fireEvent.change(screen.getByLabelText("Transporte MCP"), { target: { value: "http" } })
  fireEvent.change(screen.getByLabelText("URL MCP"), { target: { value: "https://example.test/mcp" } })
  expect(connect).toBeEnabled()
})

it("F007: keeps footer actions in a named accessible group across Tools, Permissions and Computer", async () => {
  const user = userEvent.setup()
  const api = createMockApi()
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Missing bot fixture")
  const close = vi.fn()
  render(
    <BotSettingsModal
      bot={bot}
      api={api}
      projects={[]}
      routines={[]}
      actions={{ updateBot: vi.fn() } as unknown as WorkspaceActions}
      onClose={close}
    />,
  )
  const footer = screen.getByRole("group", { name: "Ações das configurações do bot" })
  // WebKit (the macOS app) hides children of a flex <fieldset> from the accessibility tree.
  expect(footer.tagName).not.toBe("FIELDSET")
  await user.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  expect(screen.getByRole("group", { name: "Ações das configurações do bot" })).toBe(footer)
  for (const name of ["Ferramentas", "Permissões", "Computador"]) {
    await user.click(screen.getByRole("tab", { name }))
    expect(screen.getByRole("group", { name: "Ações das configurações do bot" })).toBe(footer)
    expect(within(footer).getByRole("button", { name: "Salvar configurações" })).toBeVisible()
    expect(within(footer).getByRole("button", { name: "Cancelar" })).toBeVisible()
    expect(footer.closest('[hidden], [inert], [aria-hidden="true"], [role="tabpanel"]')).toBeNull()
  }
  const save = within(footer).getByRole("button", { name: "Salvar configurações" })
  const cancel = within(footer).getByRole("button", { name: "Cancelar" })
  save.focus()
  await user.tab({ shift: true })
  expect(cancel).toHaveFocus()
  await user.tab()
  expect(save).toHaveFocus()
  cancel.focus()
  await user.keyboard("{Enter}")
  expect(close).toHaveBeenCalledOnce()
})

const path = "/Users/test/javascript/Hodler"
const linked = (input: object): ToolCallPart => ({
  type: "tool_call",
  callId: "link-project",
  tool: "mcp__touri__project_link",
  inputJson: JSON.stringify(input),
  summary: "project_link",
  outputJson: "Projeto vinculado.",
  ok: true,
})
const approved: ApprovalPart = {
  type: "approval",
  approvalId: "approved-project",
  request: "permission",
  scope: { source: "mcp", server: "touri", tool: "project_link" },
  detail: `project_link: ${JSON.stringify({ path, name: "Hodler personalizado", projectId: "hodler-id", previousProject: null, nextTurn: false })}`,
  decision: "approved",
}

it("F008: a standalone completed project card includes the project folder name", () => {
  render(<ToolCallCard part={linked({ path })} finished />)
  expect(screen.getByText(`Vincular Hodler (${path}) a este bot`)).toBeVisible()
})

it.each([{ path }, { projectId: "hodler-id" }])(
  "F008: preserves the reviewed name for completed input %j",
  async (input) => {
    const user = userEvent.setup()
    const view = render(<ToolCallList parts={[linked(input), approved]} finished createdAt={0} />)
    await user.click(screen.getByText("1 ferramenta"))
    expect(view.container.querySelectorAll(".tool-call-card")).toHaveLength(1)
    expect(screen.getByText(`Vincular Hodler personalizado (${path}) a este bot`)).toBeInTheDocument()
  },
)

it("F008: canonical setup matching never associates another target or external server", () => {
  expect(approvalMatchesTool(approved, linked({ path: "/Users/test/Other" }))).toBe(false)
  expect(approvalMatchesTool(approved, linked({ projectId: "other-id" }))).toBe(false)
  expect(
    approvalMatchesTool(
      { ...approved, scope: { source: "mcp", server: "other", tool: "project_link" } },
      linked({ path }),
    ),
  ).toBe(false)
})
