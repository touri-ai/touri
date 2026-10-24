import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import type { ApiRoutes, Bot, Message, RoutineRun, Run, Thread } from "@touri/contracts"
import { toolCatalog } from "@touri/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import App from "../src/App"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { latestPreview } from "../src/botPreview"
import { BotMcpSettings } from "../src/components/BotMcpSettings"
import { ChatPanel } from "../src/components/ChatPanel"
import CronScreen from "../src/components/CronScreen"
import { ProviderLogin } from "../src/components/ProviderLogin"
import { SETTINGS } from "../src/features/commandPalette/settingsRegistry"
import { focusSetting } from "../src/features/commandPalette/useSettingFocus"
import { localizeNotice, localizeToolText, mcpGroupLabel, t } from "../src/i18n"
import { applyDelta, useWorkspace, type WorkspaceActions } from "../src/useWorkspace"
import { chooseRoutineAction, openBotDetails } from "./workspaceNavigation"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const fixture = () => {
  const api = createMockApi()
  const bot = api.getState().bots[0] as Bot
  const thread = api.getState().threads.find((item) => item.botId === bot.id) as Thread
  return { api, bot, thread }
}
const message = (id: string, parentId: string | null, text: string, patch: Partial<Message> = {}): Message => ({
  id,
  parentId,
  text,
  threadId: "thread-mark",
  role: "assistant",
  kind: "text",
  status: "complete",
  runId: null,
  parts: [{ type: "text", text }],
  sender: null,
  source: "local",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
})
const run = (id: string, patch: Partial<Run> = {}): Run => ({
  id,
  threadId: "thread-mark",
  botId: "bot-mark",
  provider: "claude",
  trigger: "routine",
  status: "succeeded",
  routineRunId: null,
  requestMessageId: null,
  replyMessageId: null,
  externalTurnId: null,
  errorClass: null,
  errorMessage: null,
  usage: null,
  queuedAt: 2,
  startedAt: 2,
  finishedAt: 3,
  ...patch,
})
const chatProps = () => {
  const { api, bot, thread } = fixture()
  return {
    api,
    bot,
    thread,
    messages: [] as Message[],
    runs: [] as Run[],
    onSend: vi.fn(async () => undefined),
    onRetry: vi.fn(async () => undefined),
    onCancel: vi.fn(async () => undefined),
    onSwitchBranch: vi.fn(async () => undefined),
    computerGrant: null,
    onComputerGrant: vi.fn(),
    onOpenTools: vi.fn(),
  }
}

describe("r3 P2 chat and navigation", () => {
  it("renders one branch at a time and both version buttons select a real version", () => {
    const props = chatProps()
    const messages = [
      message("user", null, "pergunta", { role: "user" }),
      message("v1", "user", "versão um"),
      message("v2", "user", "versão dois"),
    ]
    const view = render(<ChatPanel {...props} messages={messages} thread={{ ...props.thread, activeLeafId: "v2" }} />)
    expect(screen.queryByText("versão um")).toBeNull()
    expect(screen.getByText("2/2")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Ramificação anterior" }))
    expect(props.onSwitchBranch).toHaveBeenCalledWith(props.thread.id, "v1")
    view.rerender(<ChatPanel {...props} messages={messages} thread={{ ...props.thread, activeLeafId: "v1" }} />)
    expect(screen.queryByText("versão dois")).toBeNull()
    expect(screen.getByText("1/2")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Próxima ramificação" }))
    expect(props.onSwitchBranch).toHaveBeenLastCalledWith(props.thread.id, "v2")
  })

  it("preserves partial output and shows Cancelado", () => {
    render(
      <ChatPanel {...chatProps()} messages={[message("cancel", null, "resposta parcial", { status: "canceled" })]} />,
    )
    expect(screen.getByText("resposta parcial")).toBeVisible()
    expect(screen.getByRole("status")).toHaveTextContent("Cancelado")
    expect(screen.queryByRole("button", { name: "Parar" })).toBeNull()
  })

  it("derives a historical tool's final state without inventing its output or success", () => {
    render(
      <ChatPanel
        {...chatProps()}
        runs={[run("historical-finished")]}
        messages={[
          message("old", null, "concluído", {
            status: "streaming",
            runId: "historical-finished",
            parts: [
              {
                type: "tool_call",
                callId: "bash",
                tool: "Bash",
                summary: "Show current time",
                inputJson: '{"command":"date","description":"Show current time"}',
                outputJson: null,
                ok: null,
              },
            ],
          }),
        ]}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /1 ação/ }))
    expect(screen.getByText("Encerrado")).toBeVisible()
    fireEvent.click(screen.getByText("Detalhes técnicos"))
    expect(screen.getByText("Resultado histórico indisponível.")).toBeVisible()
    expect(screen.queryByText("Aguardando resultado.")).toBeNull()
    expect(screen.getByText("Mostrar a hora atual", { selector: ".tool-summary" })).toBeVisible()
  })

  it("⌘K focuses the field, preserves clicks inside, finds empty threads by bot/name, then navigates", async () => {
    const { api } = fixture()
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    fireEvent.keyDown(window, { key: "k", metaKey: true })
    const input = await screen.findByRole("combobox", { name: "Buscar bots, conversas e configurações" })
    expect(input).toHaveFocus()
    fireEvent.click(input)
    expect(input).toBeVisible()
    fireEvent.change(input, { target: { value: "onb" } })
    expect(screen.queryByText("Nenhum resultado encontrado.")).toBeNull()
    const [first] = within(screen.getByRole("dialog", { name: "Paleta de comandos" })).getAllByRole("option", {
      name: /onb/,
    })
    if (!first) throw new Error("Resultado ausente")
    fireEvent.click(first)
    await screen.findByRole("textbox", { name: "Mensagem para onb" })
    expect(screen.queryByRole("combobox", { name: "Buscar bots, conversas e configurações" })).toBeNull()
  })

  it("notification Abrir closes the center before navigation", async () => {
    const { api } = fixture()
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    act(() =>
      api.notify({ kind: "done", title: "Done", body: "resultado r3", botId: "bot-onb", threadId: "thread-onb" }),
    )
    fireEvent.click(screen.getByRole("button", { name: "Notificações" }))
    fireEvent.click(screen.getByRole("button", { name: "Ver conversa" }))
    expect(screen.queryByRole("region", { name: "Central de notificações" })).toBeNull()
    expect(screen.getByRole("button", { name: "Notificações" })).toHaveAttribute("aria-expanded", "false")
    await waitFor(() => expect(screen.queryByText("resultado r3")).toBeNull())
  })

  it("permissions button saves Codex full access without approvals and provider default effort", async () => {
    const { api } = fixture()
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    await openBotDetails()
    fireEvent.click(screen.getByRole("button", { name: "Ajustar permissões" }))
    const panel = await screen.findByRole("dialog", { name: "Permissões do bot" })
    expect(within(panel).queryByRole("option", { name: "Acesso total com aprovação" })).toBeNull()
    fireEvent.change(within(panel).getByLabelText("Acesso", { selector: "select" }), { target: { value: "full" } })
    fireEvent.click(within(panel).getByRole("tab", { name: "Modelo" }))
    fireEvent.change(within(panel).getByLabelText("Raciocínio"), { target: { value: "" } })
    fireEvent.click(within(panel).getByRole("button", { name: "Salvar configurações" }))
    await waitFor(() =>
      expect(
        api.calls.some(
          (call) =>
            call.route === "PATCH /bots/:id" &&
            (call.input as Partial<Bot>).access === "full" &&
            (call.input as Partial<Bot>).approvals === "never" &&
            (call.input as Partial<Bot>).reasoningEffort === null,
        ),
      ).toBe(true),
    )
  })
})

describe("r3 login and MCP settings", () => {
  it("P1-3 login recovery opens permissions and disappears after the next successful reply", async () => {
    const props = chatProps()
    const onOpenPermissions = vi.fn()
    const failed = message("failed-login", null, "", {
      status: "failed",
      parts: [{ type: "notice", code: "run_failed", level: "error", text: "cli_auth: login ausente" }],
    })
    const view = render(<ChatPanel {...props} messages={[failed]} onOpenPermissions={onOpenPermissions} />)
    fireEvent.click(await screen.findByRole("button", { name: "Entrar no Codex nesta máquina" }))
    expect(onOpenPermissions).toHaveBeenCalledOnce()
    view.rerender(
      <ChatPanel
        {...props}
        messages={[failed, message("recovered", "failed-login", "Conectado", { createdAt: 2 })]}
        onOpenPermissions={onOpenPermissions}
      />,
    )
    expect(screen.queryByRole("button", { name: "Entrar no Codex nesta máquina" })).toBeNull()
  })
  it("failed-turn login CTA opens the provider-login control for the bot instead of generic permissions", async () => {
    const props = chatProps()
    const onOpenPermissions = vi.fn()
    const onOpenProviderLogin = vi.fn()
    const failed = message("failed-login-cta", null, "", {
      status: "failed",
      parts: [{ type: "notice", code: "run_failed", level: "error", text: "cli_auth: login ausente" }],
    })
    render(
      <ChatPanel
        {...props}
        messages={[failed]}
        onOpenPermissions={onOpenPermissions}
        onOpenProviderLogin={onOpenProviderLogin}
      />,
    )
    fireEvent.click(await screen.findByRole("button", { name: "Entrar no Codex nesta máquina" }))
    expect(onOpenProviderLogin).toHaveBeenCalledOnce()
    expect(onOpenPermissions).not.toHaveBeenCalled()
  })
  it("the provider-login row is reachable through the settings registry focus mechanism", async () => {
    const { api } = fixture()
    const request: ApiRequest = vi.fn(async (route) =>
      route === "GET /bots/:id/provider-login/flow"
        ? { provider: "codex", state: "ready" }
        : {
            provider: "codex",
            ready: false,
            source: "missing",
            configuredSource: "host-file",
            health: "not-found",
            message: "Codex ainda não está conectado neste bot.",
          },
    ) as ApiRequest
    render(<ProviderLogin api={{ ...api, request }} botId="qa-r3" provider="codex" onConfigured={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText("Fonte do login")).toHaveValue("host-file"))
    const release = focusSetting(SETTINGS.providerLogin.id)
    expect(document.activeElement).toBe(screen.getByLabelText("Fonte do login"))
    expect(screen.getByLabelText("Fonte do login")).toHaveValue("host-file")
    release()
  })
  it.each(["claude", "codex"] as const)(
    "offers a recoverable %s login, stores it for this bot and clears the field",
    async (provider) => {
      const { api } = fixture()
      const request: ApiRequest = vi.fn(async (route) =>
        route === "GET /bots/:id/provider-login/flow"
          ? { provider, state: "cancelled" }
          : route === "GET /bots/:id/provider-login"
            ? { provider, ready: false, source: "missing", message: "Login ausente" }
            : route === "POST /bots/:id/provider-login/flow"
              ? { provider, state: "ready" }
              : {},
      ) as ApiRequest
      const configured = vi.fn()
      render(<ProviderLogin api={{ ...api, request }} botId="qa-r3" provider={provider} onConfigured={configured} />)
      await screen.findByText("Login cancelado.")
      fireEvent.click(screen.getByRole("button", { name: "Colar token manualmente" }))
      const input = screen.getByLabelText(provider === "claude" ? "Token OAuth do Claude" : "Login JSON do Codex")
      expect(input).toHaveAttribute("type", "password")
      fireEvent.change(input, { target: { value: "secret-r3" } })
      fireEvent.click(screen.getByRole("button", { name: "Salvar login no cofre" }))
      await waitFor(() => expect(configured).toHaveBeenCalledOnce())
      expect(request).toHaveBeenCalledWith(
        "POST /bots/:id/provider-login/flow",
        { provider, action: "paste", value: "secret-r3" },
        { id: "qa-r3" },
      )
      expect(document.querySelector('input[type="password"]')).toBeNull()
      expect(document.body.textContent).not.toContain("secret-r3")
    },
  )

  it.each(["stdio", "http"] as const)(
    "attaches %s MCP servers to the selected bot and shows verified tools",
    async (transport) => {
      const { api } = fixture()
      const request: ApiRequest = vi.fn(async (route, input) =>
        route === "GET /bots/:id/mcp"
          ? { servers: [] }
          : { server: { ...input, tools: [{ name: "search_threads", description: "" }] } },
      ) as ApiRequest
      render(<BotMcpSettings api={{ ...api, request }} botId="mail-r3" />)
      fireEvent.click(screen.getByRole("button", { name: "Configuração técnica (MCP)" }))
      await screen.findByText(/Nenhum servidor externo conectado/)
      fireEvent.change(screen.getByLabelText("Nome do servidor MCP"), { target: { value: "gmail" } })
      fireEvent.change(screen.getByLabelText("Transporte MCP"), { target: { value: transport } })
      fireEvent.change(screen.getByLabelText(transport === "stdio" ? "Comando MCP" : "URL MCP"), {
        target: { value: transport === "stdio" ? "gmail-mcp" : "https://example.com/mcp" },
      })
      fireEvent.click(screen.getByRole("button", { name: "Testar conexão" }))
      await waitFor(() => expect(screen.getByRole("button", { name: "Conectar servidor MCP" })).toBeEnabled())
      fireEvent.click(screen.getByRole("button", { name: "Conectar servidor MCP" }))
      await screen.findByText(/Conexão disponível:/)
      expect(screen.queryByText("search_threads")).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole("button", { name: "Configuração técnica (MCP)" }))
      await screen.findByText("search_threads")
      expect(request).toHaveBeenCalledWith("PUT /bots/:id/mcp/:name", expect.objectContaining({ transport }), {
        id: "mail-r3",
        name: "gmail",
      })
    },
  )
})

describe("r3 P1-4 and P3 routines", () => {
  it("disables run-now immediately so Enter + Space can't start twice", async () => {
    const { api, bot } = fixture()
    const routine = (await api.request("GET /routines", {})).routines[0]
    if (!routine) throw new Error("missing routine")
    let finish: (() => void) | undefined
    const runRoutine = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    render(
      <CronScreen
        selectedBotId={bot.id}
        bots={[bot]}
        routines={[routine]}
        routineRuns={[]}
        messages={[]}
        actions={{ runRoutine } as unknown as WorkspaceActions}
        onReviewApprovals={vi.fn()}
        onNotice={vi.fn()}
      />,
    )
    await chooseRoutineAction(routine.name, "Rodar agora")
    fireEvent.click(screen.getByRole("button", { name: `Ações da rotina ${routine.name}` }))
    const button = screen.getByRole("menuitem", { name: "Rodar agora" })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    fireEvent.keyDown(button, { key: "Enter" })
    fireEvent.keyDown(button, { key: " " })
    expect(runRoutine).toHaveBeenCalledOnce()
    await act(async () => finish?.())
  })

  it("names cron cards and places them between older and newer chat messages", () => {
    const props = chatProps()
    const routine = { id: "clock", name: "teste-relogio" } as ApiRoutes["GET /routines"]["res"]["routines"][number]
    const routineRun = { id: "rr", routineId: "clock" } as RoutineRun
    const { container } = render(
      <ChatPanel
        {...props}
        routines={[routine]}
        routineRuns={[routineRun]}
        runs={[run("r", { routineRunId: "rr", queuedAt: 2 })]}
        messages={[
          message("before", null, "antiga", { createdAt: 1 }),
          message("after", "before", "nova", { createdAt: 3 }),
        ]}
      />,
    )
    expect(screen.getByText("teste-relogio")).toBeVisible()
    expect([...container.querySelectorAll(".message-scroll article")].map((item) => item.textContent)).toEqual([
      expect.stringContaining("antiga"),
      expect.stringContaining("teste-relogio"),
      expect.stringContaining("nova"),
    ])
  })

  it("calendar uses distinct bot colors and filters both dots and legend", async () => {
    const { api } = fixture()
    const bots = api
      .getState()
      .bots.slice(0, 2)
      .map((bot) => ({ ...bot, color: "#3ecf8e" }))
    const base = (await api.request("GET /routines", {})).routines[0]
    if (!base) throw new Error("missing routine")
    const routines = bots.map((bot, i) => ({ ...base, id: `routine-${i}`, botId: bot.id }))
    const routineRuns = routines.map((routine, i) => ({
      id: `run-${i}`,
      routineId: routine.id,
      scheduledFor: Date.now(),
      status: "succeeded",
      triggerSource: "manual",
    })) as RoutineRun[]
    const { container } = render(
      <CronScreen
        selectedBotId={bots[0]?.id ?? null}
        bots={bots}
        routines={routines}
        routineRuns={routineRuns}
        messages={[]}
        actions={{} as WorkspaceActions}
        onReviewApprovals={vi.fn()}
        onNotice={vi.fn()}
      />,
    )
    const dots = [...container.querySelectorAll<HTMLElement>("[data-run-id]")]
    expect(dots).toHaveLength(2)
    expect(dots[0]?.style.background).not.toBe(dots[1]?.style.background)
    fireEvent.change(screen.getByRole("combobox", { name: "Bot", exact: true }), { target: { value: bots[0]?.id } })
    expect(container.querySelectorAll("[data-run-id]")).toHaveLength(1)
    expect(container.querySelector(".calendar-legend")?.textContent).not.toContain(bots[1]?.name)
  })
})

describe("r3 P3 integrity", () => {
  it("bot updates retain the sidebar order and stopped processes remove stale previews", async () => {
    const { api } = fixture()
    const hook = renderHook(() => useWorkspace(api))
    await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
    await waitFor(() => expect(hook.result.current.data.processes.length).toBeGreaterThan(0))
    const order = hook.result.current.data.bots.map((bot) => bot.id)
    const bot = hook.result.current.data.bots[0] as Bot
    const process = hook.result.current.data.processes[0]
    act(() => api.emit({ type: "bot.updated", bot: { ...bot, projectId: "new-project" } }))
    expect(hook.result.current.data.bots.map((bot) => bot.id)).toEqual(order)
    if (!process) throw new Error("missing process")
    act(() =>
      api.emit({
        type: "preview.available",
        preview: {
          projectId: process.spec.projectId,
          processId: process.spec.id,
          url: "http://localhost:4310",
          port: 4310,
          label: "web",
        },
      }),
    )
    act(() => api.emit({ type: "process.updated", spec: process.spec, run: null }))
    expect(hook.result.current.data.previews).toHaveLength(0)
  })

  it("empty preview disables Parar", async () => {
    const { api } = fixture()
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    await openBotDetails()
    fireEvent.click(screen.getByRole("button", { name: "Preview do projeto" }))
    await screen.findByRole("heading", { name: "Preview", exact: true })

    for (const button of screen.getAllByRole("button", { name: "Parar" })) expect(button).toBeDisabled()
  })

  it("stream offsets merge snapshots and replays without SouSou/EuEu or removing legitimate repeated tokens", () => {
    let messages = [message("m", null, "Sou", { status: "streaming" })]
    messages = applyDelta(messages, "m", "Sou", 0, 0)
    messages = applyDelta(messages, "m", " o bot", 0, 3)
    messages = applyDelta(messages, "m", " o bot", 0, 3)
    expect(messages[0]?.text).toBe("Sou o bot")
    expect(applyDelta([message("m", null, "Eu", { status: "streaming" })], "m", "Eu leria", 0, 0)[0]?.text).toBe(
      "Eu leria",
    )
    expect(applyDelta([message("m", null, "ha", { status: "streaming" })], "m", "ha", 0, 2)[0]?.text).toBe("haha")
  })

  it("all gateway descriptions, categories, roles and provider notices have Portuguese dictionary entries", () => {
    for (const tool of toolCatalog.tools) expect(localizeNotice(tool.description)).not.toBe(tool.description)
    for (const group of ["core", "project", "process", "secret", "preview", "browser", "computer"])
      expect(mcpGroupLabel(group)).not.toBe(`MCP ${group}`)
    expect(t("user")).toBe("Você")
    expect(t("assistant")).toBe("Assistente")
    expect(t("tool")).toBe("Ferramenta")
    expect(localizeNotice("The native provider session was replaced and a handoff was supplied.")).toContain(
      "contexto da conversa foi preservado",
    )
    expect(localizeNotice("cli_crash: Error: falha do provedor")).toBe(
      "O provedor encerrou inesperadamente: falha do provedor",
    )
    expect(
      latestPreview({
        threadIds: ["thread-mark"],
        messages: [
          message("error", null, "", {
            status: "failed",
            parts: [{ type: "notice", code: "run_failed", level: "error", text: "cli_auth: Error: login ausente" }],
          }),
        ],
      }),
    ).toBe("O provedor não está autenticado")
    expect(localizeToolText('{"description":"Show current time","command":"date"}')).toContain("Mostrar a hora atual")
  })
})
