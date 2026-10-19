import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { McpServer, Message } from "@touri/contracts"
import { describe, expect, it, vi } from "vitest"
import App from "../src/App"
import type { ApiRequest, TauriInvoke } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import CronScreen from "../src/components/CronScreen"
import { NotificationBell } from "../src/components/NotificationCenter"
import { PreviewPane } from "../src/components/PreviewPane"
import { ScreenServerPolicies } from "../src/components/ScreenConnections"
import { McpScreen, PreviewScreen } from "../src/components/WorkspaceScreens"
import type { WorkspaceActions } from "../src/useWorkspace"
import { openRoutines } from "./workspaceNavigation"

const server: McpServer = {
  name: "arquivos",
  transport: "stdio",
  command: "npx",
  args: [],
  tools: [{ name: "read_file", description: "Ler um arquivo.", classification: "reads", policy: "needs_approval" }],
}

const previewFixture = async () => {
  const api = createMockApi()
  const project = (await api.request("GET /projects", {})).projects[0]
  if (!project) throw new Error("Missing project")
  const processes = (await api.request("GET /projects/:id/processes", {}, { id: project.id })).processes
  return {
    api,
    project,
    processes,
    preview: null,
    browserTabs: [],
    selectedBot: api.getState().bots[0] ?? null,
    selectedThread: api.getState().threads[0] ?? null,
    selectedMessages: [],
    invokeCommand: vi.fn(),
    onStart: vi.fn(async (_id: string) => {}),
    onStop: vi.fn(async () => {}),
    onRestart: vi.fn(async () => {}),
    onSend: vi.fn(async () => {}),
    onBack: vi.fn(),
    onConnectProject: vi.fn(),
    onNotice: vi.fn(),
  }
}

describe("r8 screens", () => {
  it("explains the approved project setup required for Preview when no project is linked", async () => {
    const props = await previewFixture()
    render(<PreviewScreen {...props} project={null} processes={[]} />)
    expect(screen.getByText(/Para usar o Preview, conecte a pasta do aplicativo/)).toHaveTextContent(
      "Você pode pedir ao bot para preparar isso; a conexão exige sua aprovação.",
    )
    fireEvent.click(screen.getAllByRole("button", { name: "Conectar projeto" })[0] as HTMLElement)
    expect(props.onConnectProject).toHaveBeenCalledOnce()
    expect(props.invokeCommand).not.toHaveBeenCalledWith("preview_show", expect.anything())
  })

  it("provides distinct Cron loading, empty and recoverable error states", () => {
    const refresh = vi.fn(async () => {})
    const props = {
      selectedBotId: null,
      bots: [],
      routines: [],
      routineRuns: [],
      messages: [],
      actions: { refresh } as unknown as WorkspaceActions,
      onReviewApprovals: vi.fn(),
      onNotice: vi.fn(),
    }
    const view = render(<CronScreen {...props} loading />)
    expect(screen.getByRole("status", { name: "Carregando" })).toBeVisible()
    expect(screen.queryByText("Sua primeira rotina começa aqui")).toBeNull()
    view.rerender(<CronScreen {...props} loadError="offline" />)
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível carregar")
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }))
    expect(refresh).toHaveBeenCalledOnce()
    view.rerender(<CronScreen {...props} />)
    expect(screen.getByText("Sua primeira rotina começa aqui")).toBeVisible()
    expect(screen.getByRole("button", { name: "Criar rotina" })).toBeDisabled()
  })

  it("retries an unavailable native Preview using a new session", async () => {
    const geometry = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 400,
      bottom: 400,
      width: 400,
      height: 400,
      toJSON: () => ({}),
    })
    let shows = 0
    const invoke = vi.fn(async (command: string) => {
      if (command === "preview_show") {
        shows += 1
        if (shows === 1) throw new Error("Unavailable")
        return { label: "retry-preview" }
      }
      return {}
    }) as unknown as TauriInvoke
    const view = render(
      <PreviewPane
        preview={{ projectId: "project", processId: "web", label: "web", port: 4310, url: "http://localhost:4310/" }}
        modalOpen={false}
        invokeCommand={invoke}
        onOpenAgentBrowser={vi.fn()}
      />,
    )
    try {
      await screen.findByRole("alert")
      fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }))
      await waitFor(() => expect(shows).toBe(2))
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
    } finally {
      view.unmount()
      geometry.mockRestore()
    }
  })

  it("keeps cleared notification history hidden after remount without hiding new records", async () => {
    const api = createMockApi()
    const item = api.notify({ kind: "done", title: "Resumo antigo", body: "Resultado disponível", createdAt: 100 })
    const actions = {
      open: vi.fn(),
      dismiss: vi.fn(),
      dismissAll: vi.fn(async () => {}),
      respond: vi.fn(),
      reply: vi.fn(),
    }
    const view = render(<NotificationBell notifications={[item]} actions={actions} />)
    fireEvent.click(screen.getByRole("button", { name: "Notificações" }))
    fireEvent.click(screen.getByRole("button", { name: "Limpar" }))
    await waitFor(() => expect(screen.queryAllByTestId("notification-row")).toHaveLength(0))
    view.unmount()
    render(
      <NotificationBell notifications={[item, { ...item, createdAt: 200, title: "Resumo novo" }]} actions={actions} />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Notificações" }))
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1)
    expect(screen.getByTestId("notification-row")).toHaveTextContent("Resumo novo")
  })

  it("ignores a policy response after navigating away from its bot", async () => {
    const api = createMockApi()
    let finish: ((value: { server: McpServer }) => void) | undefined
    const request = new Promise<{ server: McpServer }>((resolve) => {
      finish = resolve
    })
    api.request = (() => request) as ApiRequest
    const onUpdate = vi.fn()
    const view = render(<ScreenServerPolicies api={api} botId="bot-mark" server={server} onUpdate={onUpdate} />)
    fireEvent.change(screen.getByRole("combobox", { name: "Política · read_file" }), { target: { value: "blocked" } })
    view.unmount()
    await act(async () => {
      finish?.({ server })
      await request
    })
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it("distinguishes a manual Cron run from resuming the schedule", async () => {
    const api = createMockApi()
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    openRoutines("mark")
    const run = await screen.findByRole("button", { name: "Rodar agora Daily brief" })
    expect(run).toHaveTextContent("Rodar agora")
    expect(screen.getByRole("button", { name: "Retomar Daily brief" })).toHaveTextContent("Retomar")
    fireEvent.click(run)
    await waitFor(() => expect(api.calls.some((call) => call.route === "POST /routines/:id/run")).toBe(true))
    expect((await api.request("GET /routines", {})).routines[0]?.enabled).toBe(false)
    expect(api.calls.some((call) => call.route === "PATCH /routines/:id")).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Retomar Daily brief" }))
    fireEvent.click(screen.getByRole("button", { name: "Revisar rotina" }))
    fireEvent.click(screen.getByRole("button", { name: "Ativar rotina" }))
    await screen.findByRole("button", { name: "Pausar Daily brief" })
    expect((await api.request("GET /routines", {})).routines[0]?.enabled).toBe(true)
  })

  it("opens the owning thread's pending approval from the Preview mini-chat", async () => {
    const api = createMockApi()
    const thread = api.getState().threads.find((item) => item.id === "thread-mark")
    const base = api.getState().messages[0]
    if (!thread || !base) throw new Error("Missing thread")
    const reply: Message = {
      ...base,
      id: "preview-pending",
      threadId: thread.id,
      parentId: null,
      role: "assistant",
      text: "**Confira** os arquivos.",
      parts: [
        { type: "text", text: "**Confira** os arquivos." },
        {
          type: "approval",
          approvalId: "preview-request",
          request: "permission",
          detail: "Read: README.md",
          decision: "pending",
          allowStanding: true,
          scope: { source: "claude", tool: "Read" },
        },
      ],
    }
    api.getState().messages.push(reply)
    thread.activeLeafId = reply.id
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    if (!screen.queryByRole("button", { name: "Preview do projeto" }))
      fireEvent.click(screen.getByRole("button", { name: "Painel do bot" }))
    fireEvent.click(screen.getByRole("button", { name: "Preview do projeto" }))
    await screen.findByRole("heading", { name: "Preview", exact: true })

    const preview = document.querySelector(".preview-chat-sidebar") as HTMLElement
    await within(preview).findByText("Confira", { selector: "strong" })
    expect(within(preview).queryByRole("article", { name: "Aprovação de ferramenta" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Aprovação pendente — abrir no chat/ }))
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    expect(screen.getByRole("article", { name: "Aprovação de ferramenta" })).toHaveAttribute(
      "data-approval-id",
      "preview-request",
    )
  })

  it("offers a reply box only for a real question, not for a finished reply that ends in a question mark", () => {
    const api = createMockApi()
    const greeting = api.notify({ kind: "done", title: "Done", body: "Oi! Como posso ajudar?", createdAt: 2 })
    const question = api.notify({ kind: "question", title: "Question", body: "Subo o servidor?", createdAt: 1 })
    render(
      <NotificationBell
        notifications={[greeting, question]}
        now={3}
        actions={{ open: vi.fn(), dismiss: vi.fn(), dismissAll: vi.fn(), respond: vi.fn(), reply: vi.fn() }}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /Notificações/ }))
    const [done, asked] = screen.getAllByTestId("notification-row")
    expect(done?.querySelector(".notification-reply")).toBeNull()
    expect(asked?.querySelector(".notification-reply")).not.toBeNull()
  })

  it("groups notifications by local day and recency, marks them read, and clears history", async () => {
    const api = createMockApi()
    const now = new Date(2026, 9, 13, 12).getTime()
    const old = api.notify({
      kind: "turn-failed",
      title: "Falha anterior",
      body: "Conexão encerrada",
      createdAt: now - 86_400_000,
    })
    const fresh = api.notify({
      kind: "done",
      title: "Revisão concluída",
      body: "**Tudo certo**",
      createdAt: now - 1000,
    })
    const read = vi.fn(async () => {})
    const clear = vi.fn(async () => {})
    render(
      <NotificationBell
        notifications={[old, fresh]}
        now={now}
        actions={{ open: vi.fn(), dismiss: read, dismissAll: clear, respond: vi.fn(), reply: vi.fn() }}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /Notificações/ }))
    const rows = screen.getAllByTestId("notification-row")
    expect(rows[0]).toHaveTextContent("Revisão concluída")
    expect(rows[1]).toHaveTextContent("Não consegui conectar à sua IA.")
    expect(screen.getByRole("heading", { name: "Hoje" })).toBeVisible()
    expect(screen.getByRole("heading", { name: "Anteriores" })).toBeVisible()
    fireEvent.click(within(rows[0] as HTMLElement).getByRole("button", { name: "Marcar como lida" }))
    await waitFor(() => expect(read).toHaveBeenCalledWith(fresh.id))
    fireEvent.click(screen.getByRole("button", { name: "Limpar" }))
    await waitFor(() => expect(screen.queryAllByTestId("notification-row")).toHaveLength(0))
    expect(clear).toHaveBeenCalledOnce()
  })

  it("keeps notification failures recoverable", async () => {
    const api = createMockApi()
    const item = api.notify({ kind: "done", title: "Concluído", body: "Resumo disponível" })
    const dismiss = vi.fn().mockRejectedValueOnce(new Error("Falha ao marcar")).mockResolvedValue(undefined)
    render(
      <NotificationBell
        notifications={[item]}
        actions={{ open: vi.fn(), dismiss, dismissAll: vi.fn(), respond: vi.fn(), reply: vi.fn() }}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Notificações" }))
    fireEvent.click(screen.getByRole("button", { name: "Marcar como lida" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Falha ao marcar")
    fireEvent.click(screen.getByRole("button", { name: "Marcar como lida" }))
    await waitFor(() => expect(dismiss).toHaveBeenCalledTimes(2))
  })

  it("shows the gateway's actual connection state and retries a failed request", async () => {
    const api = createMockApi()
    const original = api.request
    let failed = false
    api.request = ((route, input, path) => {
      if (route === "GET /mcp/tools" && !failed) {
        failed = true
        return Promise.reject(new Error("Connection failed"))
      }
      return original(route, input, path)
    }) as ApiRequest
    render(<McpScreen api={api} />)
    expect(screen.getByRole("status", { name: "Carregando" })).toBeVisible()
    expect(await screen.findByText("Não foi possível carregar")).toBeVisible()
    expect(screen.getByText("Indisponível")).toBeVisible()
    expect(screen.queryByText("Conectado", { exact: true })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }))
    await screen.findByText("Conectado", { exact: true })
    expect(screen.queryByText("Não foi possível carregar")).toBeNull()
    expect(screen.getByText("Nenhum servidor externo conectado")).toBeVisible()
  })

  it("describes the built-in tools in plain language without the word gateway", async () => {
    const api = createMockApi()

    const { container } = render(<McpScreen api={api} />)
    await screen.findByText("Conectado", { exact: true })

    expect(screen.getByText(/Ferramentas do touri neste computador/)).toBeVisible()
    expect(screen.getByText("Ferramentas do touri")).toBeVisible()
    expect(container.textContent?.toLowerCase()).not.toContain("gateway")
  })

  it("updates only the selected tool's policy and preserves its access classification", async () => {
    const api = createMockApi()
    const request = vi.fn(async (route: string, input: unknown) => {
      if (route === "GET /bots/:id/mcp") return { servers: [server] }
      if (route === "GET /mcp/tools") return { server: { name: "Avançado", exact: true, version: "1" }, tools: [] }
      if (route === "PATCH /bots/:id/mcp/:name/tools/:tool")
        return { server: { ...server, tools: [{ ...server.tools[0], ...(input as object) }] } }
      throw new Error("Unexpected request")
    })
    api.request = request as ApiRequest
    render(<McpScreen api={api} botId="bot-mark" botName="mark" />)
    const select = await screen.findByRole("combobox", { name: "Política · read_file" })
    fireEvent.change(select, { target: { value: "blocked" } })
    await waitFor(() => expect(select).toHaveValue("blocked"))
    expect(request).toHaveBeenCalledWith(
      "PATCH /bots/:id/mcp/:name/tools/:tool",
      { classification: "reads", policy: "blocked" },
      { id: "bot-mark", name: "arquivos", tool: "read_file" },
    )
  })

  it("keeps a rejected MCP policy unchanged and shows a recoverable error", async () => {
    const api = createMockApi()
    const original = api.request
    api.request = ((route, input, path) => {
      if (route === "GET /bots/:id/mcp") return Promise.resolve({ servers: [server] })
      if (route === "PATCH /bots/:id/mcp/:name/tools/:tool") return Promise.reject(new Error("Denied"))
      return original(route, input, path)
    }) as ApiRequest
    render(<McpScreen api={api} botId="bot-mark" />)
    const select = await screen.findByRole("combobox", { name: "Política · read_file" })
    fireEvent.change(select, { target: { value: "always_allow" } })
    await screen.findByRole("alert")
    expect(select).toHaveValue("needs_approval")
    expect(select).toBeEnabled()
  })

  it("shows a Logs error with retry instead of placing the error inside process output", async () => {
    const props = await previewFixture()
    const original = props.api.request
    let failed = false
    props.api.request = ((route, input, path) => {
      if (route === "GET /processes/:id/logs" && !failed) {
        failed = true
        return Promise.reject(new Error("Failed"))
      }
      if (route === "GET /processes/:id/logs") return Promise.resolve({ lines: ["Servidor pronto"] })
      return original(route, input, path)
    }) as ApiRequest
    render(<PreviewScreen {...props} />)
    fireEvent.click(screen.getByRole("tab", { name: "Logs" }))
    fireEvent.change(screen.getByRole("combobox", { name: "Processo dos logs" }), { target: { value: "process-web" } })
    await screen.findByRole("alert")
    expect(screen.queryByRole("log")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }))
    expect(await screen.findByRole("log")).toHaveTextContent("Servidor pronto")
    fireEvent.click(screen.getByRole("button", { name: "Copiar" }))
    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith("Não foi possível copiar os logs."))
    fireEvent.click(screen.getByRole("button", { name: "Limpar" }))
    expect(screen.getByText("Aguardando logs do processo")).toBeVisible()
    act(() => props.api.emit({ type: "process.log", processId: "process-web", lines: ["Nova linha"] }))
    expect(await screen.findByRole("log")).toHaveTextContent("Nova linha")
  })

  it("ignores a late Logs response after selecting another process", async () => {
    const props = await previewFixture()
    let resolveWeb: ((value: { lines: string[] }) => void) | undefined
    const web = new Promise<{ lines: string[] }>((resolve) => {
      resolveWeb = resolve
    })
    props.api.request = ((_route, _input, path) =>
      path?.id === "process-web" ? web : Promise.resolve({ lines: ["Saída do worker"] })) as ApiRequest
    render(<PreviewScreen {...props} />)
    fireEvent.click(screen.getByRole("tab", { name: "Logs" }))
    const select = screen.getByRole("combobox", { name: "Processo dos logs" })
    fireEvent.change(select, { target: { value: "process-web" } })
    fireEvent.change(select, { target: { value: "process-worker" } })
    expect(await screen.findByRole("log")).toHaveTextContent("Saída do worker")
    await act(async () => {
      resolveWeb?.({ lines: ["Saída antiga"] })
      await web
    })
    expect(screen.getByRole("log")).not.toHaveTextContent("Saída antiga")
  })

  it("preserves live Logs arriving while the initial snapshot loads", async () => {
    const props = await previewFixture()
    let finish: ((value: { lines: string[] }) => void) | undefined
    const pending = new Promise<{ lines: string[] }>((resolve) => {
      finish = resolve
    })
    props.api.request = (() => pending) as ApiRequest
    render(<PreviewScreen {...props} />)
    fireEvent.click(screen.getByRole("tab", { name: "Logs" }))
    fireEvent.change(screen.getByRole("combobox", { name: "Processo dos logs" }), { target: { value: "process-web" } })
    act(() => props.api.emit({ type: "process.log", processId: "process-web", lines: ["Linha ao vivo"] }))
    await act(async () => {
      finish?.({ lines: ["Linha anterior"] })
      await pending
    })
    expect(await screen.findByRole("log")).toHaveTextContent("Linha anterior Linha ao vivo")
  })

  it("starts every stopped Preview process through the labeled action", async () => {
    const props = await previewFixture()
    render(<PreviewScreen {...props} />)
    fireEvent.click(screen.getByRole("button", { name: "Subir tudo" }))
    expect(props.onStart.mock.calls.map(([id]) => id)).toEqual(["process-web", "process-worker"])
  })
})
