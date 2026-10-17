import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { BotMcpSettings } from "../src/components/BotMcpSettings"
import { ApiError } from "../src/errors"
import { t } from "../src/i18n"

afterEach(cleanup)

const setup = () => {
  const api = createMockApi()
  const request = vi.fn(api.request)
  render(<BotMcpSettings api={{ ...api, request }} botId="catalog-bot" />)
  return { api, request }
}

it("opens friendly cards and keeps the raw connection form behind the advanced option", async () => {
  setup()
  await screen.findByText(/Nenhum servidor externo conectado/)
  const catalog = screen.getByRole("region", { name: "Catálogo de integrações MCP" })
  expect(within(catalog).getByRole("heading", { name: "Gmail" })).toBeVisible()
  expect(within(catalog).getByText("Leia, organize e envie mensagens com a conta que você autorizar.")).toBeVisible()
  expect(within(catalog).getAllByText("O que você precisa")[0]).toBeVisible()
  expect(within(catalog).getAllByRole("button", { name: "Conectar", exact: true })).toHaveLength(2)
  expect(screen.queryByLabelText("Transporte MCP")).not.toBeInTheDocument()
  expect(screen.queryByLabelText("Argumentos MCP (lista JSON)")).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Configuração técnica (MCP)" }))
  expect(screen.getByLabelText("Transporte MCP")).toBeVisible()
  expect(screen.getByLabelText("Argumentos MCP (lista JSON)")).toBeVisible()
})

it("skips preparation steps already detected on the bot's machine", async () => {
  setup()
  const gmail = screen.getByRole("heading", { name: "Gmail" }).closest("article")
  if (!gmail) throw new Error("Missing Gmail card")
  fireEvent.click(within(gmail).getByRole("button", { name: "Conectar", exact: true }))
  expect(await screen.findByText("Preparação concluída. Teste a conexão para continuar.")).toBeVisible()
  expect(screen.queryByText("Criar o acesso no Google")).not.toBeInTheDocument()
  expect(screen.queryByLabelText("Comando MCP")).not.toBeInTheDocument()
  fireEvent.click(within(gmail).getByRole("button", { name: "Conectar", exact: true }))
  await waitFor(() => expect(screen.getByRole("button", { name: "Testar conexão" })).toBeEnabled())
})

it("tests the tool listing without saving, then saves only after the explicit click", async () => {
  const { api, request } = setup()
  fireEvent.click(screen.getByRole("button", { name: "Configuração técnica (MCP)" }))
  fireEvent.change(screen.getByLabelText("Nome do servidor MCP"), { target: { value: "sample" } })
  fireEvent.change(screen.getByLabelText("Comando MCP"), { target: { value: "node" } })
  const save = screen.getByRole("button", { name: "Conectar servidor MCP" })
  expect(save).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Testar conexão" }))
  await screen.findByText(/Conexão pronta: 1 ferramenta disponível/)
  expect(request).toHaveBeenCalledWith("POST /bots/:id/mcp/test", expect.objectContaining({ name: "sample" }), {
    id: "catalog-bot",
  })
  expect(api.calls.some((call) => call.route === "PUT /bots/:id/mcp/:name")).toBe(false)
  fireEvent.click(save)
  await waitFor(() => expect(api.calls.some((call) => call.route === "PUT /bots/:id/mcp/:name")).toBe(true))
})

const advancedSetup = (test: () => Promise<unknown>) => {
  const api = createMockApi()
  const request = vi.fn((route, input, pathValues) =>
    route === "POST /bots/:id/mcp/test" ? test() : api.request(route, input, pathValues),
  ) as ApiRequest
  render(<BotMcpSettings api={{ ...api, request }} botId="catalog-bot" />)
  fireEvent.click(screen.getByRole("button", { name: "Configuração técnica (MCP)" }))
  fireEvent.change(screen.getByLabelText("Nome do servidor MCP"), { target: { value: "sample" } })
  fireEvent.change(screen.getByLabelText("Comando MCP"), { target: { value: "node" } })
  return { api, request }
}

it("shows a pending test, prevents duplicate tests and does not save while testing", async () => {
  let finish: ((value: unknown) => void) | undefined
  const test = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const { api } = advancedSetup(test)
  fireEvent.click(screen.getByRole("button", { name: "Testar conexão" }))
  expect(screen.getByRole("status")).toHaveTextContent("Buscando as ferramentas disponíveis")
  const pending = screen.getByRole("button", { name: "Testando conexão…" })
  expect(pending).toBeDisabled()
  fireEvent.click(pending)
  fireEvent.click(screen.getByRole("button", { name: "Conectar servidor MCP" }))
  expect(test).toHaveBeenCalledOnce()
  expect(api.calls.some((call) => call.route === "PUT /bots/:id/mcp/:name")).toBe(false)
  finish?.({ server: { name: "sample", transport: "stdio", command: "node", args: [], tools: [] } })
  await screen.findByText(/O servidor respondeu, mas não ofereceu ferramentas/)
})

it("explains an empty tool list and keeps saving disabled", async () => {
  advancedSetup(async () => ({ server: { name: "sample", transport: "stdio", command: "node", args: [], tools: [] } }))
  fireEvent.click(screen.getByRole("button", { name: "Testar conexão" }))
  await screen.findByText(/O servidor respondeu, mas não ofereceu ferramentas/)
  expect(screen.getByRole("button", { name: "Conectar servidor MCP" })).toBeDisabled()
})

it.each([new Error("private diagnostic details"), new ApiError(400, "", "MCP_EXECUTABLE_NOT_FOUND", "TOURI-E1012")])(
  "explains a failed test and allows a retry without exposing diagnostics",
  async (failure) => {
    const test = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({
        server: {
          name: "sample",
          transport: "stdio",
          command: "node",
          args: [],
          tools: [{ name: "read", description: "" }],
        },
      })
    advancedSetup(test)
    fireEvent.click(screen.getByRole("button", { name: "Testar conexão" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/não foi encontrado|Não foi possível conectar/)
    expect(document.body).not.toHaveTextContent("private diagnostic details")
    expect(screen.getByRole("button", { name: "Conectar servidor MCP" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Testar conexão" }))
    await screen.findByText(/Conexão pronta/)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Conectar servidor MCP" })).toBeEnabled()
  },
)

it("requires another test after editing a previously verified configuration", async () => {
  advancedSetup(async () => ({
    server: {
      name: "sample",
      transport: "stdio",
      command: "node",
      args: [],
      tools: [{ name: "read", description: "" }],
    },
  }))
  fireEvent.click(screen.getByRole("button", { name: "Testar conexão" }))
  await screen.findByText(/Conexão pronta/)
  fireEvent.change(screen.getByLabelText("Argumentos MCP (lista JSON)"), { target: { value: '["--changed"]' } })
  expect(screen.getByRole("button", { name: "Conectar servidor MCP" })).toBeDisabled()
  expect(screen.queryByText(/Conexão pronta/)).not.toBeInTheDocument()
})

it("shows only missing Gmail steps, with links, and rechecks after external setup", async () => {
  const api = createMockApi()
  const check = vi
    .fn()
    .mockResolvedValueOnce({
      prerequisites: { machine: "local", status: "checked", node: true, oauthKeys: true, credentials: false },
    })
    .mockResolvedValue({
      prerequisites: { machine: "local", status: "checked", node: true, oauthKeys: true, credentials: true },
    })
  const request = ((route, input, pathValues) =>
    route === "GET /bots/:id/mcp/prerequisites" ? check() : api.request(route, input, pathValues)) as ApiRequest
  render(<BotMcpSettings api={{ ...api, request }} botId="catalog-bot" />)
  const gmail = screen.getByRole("heading", { name: "Gmail" }).closest("article")
  if (!gmail) throw new Error("Missing Gmail card")
  fireEvent.click(within(gmail).getByRole("button", { name: "Conectar", exact: true }))
  await screen.findByText("Autorizar sua conta Google")
  expect(screen.queryByText("Criar o acesso no Google")).not.toBeInTheDocument()
  expect(screen.queryByText("Instalar Node.js")).not.toBeInTheDocument()
  expect(screen.getByRole("link", { name: "Ver instruções completas de Gmail" })).toHaveAttribute(
    "href",
    expect.stringContaining("https://github.com/"),
  )
  expect(screen.getByRole("button", { name: "Testar conexão" })).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Verificar preparação novamente" }))
  await screen.findByText("Preparação concluída. Teste a conexão para continuar.")
  expect(screen.getByRole("button", { name: "Testar conexão" })).toBeEnabled()
  expect(screen.queryByText("Autorizar sua conta Google")).not.toBeInTheDocument()
})

it("shows all missing setup steps in Portuguese without exposing the raw form", async () => {
  const api = createMockApi()
  const request = ((route, input, pathValues) =>
    route === "GET /bots/:id/mcp/prerequisites"
      ? Promise.resolve({
          prerequisites: { machine: "local", status: "checked", node: false, oauthKeys: false, credentials: false },
        })
      : api.request(route, input, pathValues)) as ApiRequest
  render(<BotMcpSettings api={{ ...api, request }} botId="catalog-bot" />)
  const gmail = screen.getByRole("heading", { name: "Gmail" }).closest("article")
  if (!gmail) throw new Error("Missing Gmail card")
  fireEvent.click(within(gmail).getByRole("button", { name: "Conectar", exact: true }))
  const steps = await screen.findByRole("list")
  expect(within(steps).getAllByRole("listitem")).toHaveLength(3)
  expect(within(steps).getByRole("link", { name: "Abrir Google Cloud" })).toHaveAttribute(
    "href",
    "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
  )
  expect(screen.queryByLabelText("Argumentos MCP (lista JSON)")).not.toBeInTheDocument()
})

it.each(["unavailable", "error"])("handles %s prerequisite checks with a retry", async (state) => {
  const api = createMockApi()
  const request = ((route, input, pathValues) =>
    route === "GET /bots/:id/mcp/prerequisites"
      ? state === "error"
        ? Promise.reject(new Error("private details"))
        : Promise.resolve({
            prerequisites: { machine: "vm", status: "unavailable", node: false, oauthKeys: false, credentials: false },
          })
      : api.request(route, input, pathValues)) as ApiRequest
  render(<BotMcpSettings api={{ ...api, request }} botId="catalog-bot" />)
  const gmail = screen.getByRole("heading", { name: "Gmail" }).closest("article")
  if (!gmail) throw new Error("Missing Gmail card")
  fireEvent.click(within(gmail).getByRole("button", { name: "Conectar", exact: true }))
  await screen.findByText(
    state === "error"
      ? "Não foi possível verificar a preparação. Tente novamente."
      : "Ligue a máquina deste bot e clique em Verificar preparação novamente.",
  )
  expect(screen.getByRole("button", { name: "Testar conexão" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Verificar preparação novamente" })).toBeEnabled()
  expect(document.body).not.toHaveTextContent("private details")
})

it("provides English labels for connection and preparation results", () => {
  expect(t("Configuração técnica (MCP)", {}, "en")).toBe("Technical configuration (MCP)")
  expect(t("Conexão pronta: {count} ferramentas disponíveis. Salve para usá-las neste bot.", { count: 1 }, "en")).toBe(
    "Connection ready: 1 tool available. Save to use it with this bot.",
  )
})

it("connects local files through the folder chooser and guided test without exposing JSON", async () => {
  const api = createMockApi()
  const invokeCommand = vi.fn().mockResolvedValue({ path: "/workspace/documents" })
  render(<BotMcpSettings api={api} botId="catalog-bot" invokeCommand={invokeCommand} />)
  const card = screen.getByRole("heading", { name: "Arquivos locais" }).closest("article")
  if (!card) throw new Error("Missing files card")
  fireEvent.click(within(card).getByRole("button", { name: "Conectar", exact: true }))
  await screen.findByText("Preparação concluída. Teste a conexão para continuar.")
  expect(screen.getByRole("button", { name: "Testar conexão" })).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Escolher pasta…" }))
  await waitFor(() =>
    expect(screen.getByLabelText("Pasta permitida (caminho absoluto)")).toHaveValue("/workspace/documents"),
  )
  expect(screen.queryByLabelText("Argumentos MCP (lista JSON)")).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Testar conexão" }))
  await screen.findByText(/Conexão pronta/)
  expect(api.calls.find((call) => call.route === "POST /bots/:id/mcp/test")?.input).toMatchObject({
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace/documents"],
  })
  fireEvent.click(screen.getByRole("button", { name: "Salvar conexão" }))
  await waitFor(() => expect(api.calls.some((call) => call.route === "PUT /bots/:id/mcp/:name")).toBe(true))
})
