import { invoke as nativeInvoke } from "@tauri-apps/api/core"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import type { ApiRequest, TauriInvoke } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { BotAccessSummary } from "../src/components/BotAccessSummary"
import { BotBrowserPicker } from "../src/components/BotBrowserPicker"
import { FolderPicker } from "../src/components/FolderPicker"
import { BotSettingsModal } from "../src/components/Modals"
import { PreviewPane } from "../src/components/PreviewPane"
import { SettingsModal } from "../src/components/SettingsModal"
import { ServerModeSettings } from "../src/features/server/ServerModeSettings"
import { ServerModeProvider, serverModeError } from "../src/features/server/serverMode"
import { t } from "../src/i18n"
import { getStorageScope, setStorageScope } from "../src/storageScope"
import type { WorkspaceActions } from "../src/useWorkspace"

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }))
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async () => ({})),
}))

const native = () => Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} })
const server = { mode: "server", url: "https://touri.example" } as const
const local = { mode: "local", url: null } as const

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__")
  setStorageScope(null)
  vi.clearAllMocks()
})

it.each([
  { status: local, canInvite: false },
  { status: server, canInvite: true },
])("only offers people invitations with a server connection ($status.mode)", async ({ status, canInvite }) => {
  native()
  const api = { ...createMockApi(), isMock: false }
  const invoke = vi.fn(async (command: string) => (command === "server_mode_status" ? status : {}))

  render(<App kernel={{ services: { api, invoke: invoke as TauriInvoke } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  const invite = screen.queryByRole("button", { name: "Convidar pessoa", exact: true })
  if (!canInvite) {
    expect(invite).not.toBeInTheDocument()
    return
  }

  expect(invite).toBeVisible()
})

it("keeps the advanced native server setting out of the browser app", () => {
  const invoke = vi.fn()
  render(<SettingsModal invokeCommand={invoke} settings={null} onSave={vi.fn()} onClose={vi.fn()} />)
  expect(screen.queryByRole("tab", { name: "Avançado" })).not.toBeInTheDocument()
  expect(screen.queryByRole("region", { name: "Usar um servidor touri" })).not.toBeInTheDocument()
  expect(invoke).not.toHaveBeenCalled()
})

it("pairs with a one-time code, clears it and announces the native restart", async () => {
  native()
  const invoke = vi.fn(async (command: string) => (command === "server_mode_status" ? local : server))
  render(<ServerModeSettings invokeCommand={invoke as unknown as TauriInvoke} />)
  await screen.findByText("Modo local ativo")
  fireEvent.change(screen.getByLabelText("Endereço do servidor"), { target: { value: "https://touri.example" } })
  const code = screen.getByLabelText("Código de pareamento")
  expect(code).toHaveAttribute("type", "password")
  fireEvent.change(code, { target: { value: " 123456 " } })
  fireEvent.click(screen.getByRole("button", { name: "Conectar ao servidor" }))
  await screen.findByText("Servidor conectado. O touri vai reiniciar neste modo.")
  expect(invoke).toHaveBeenCalledWith("server_mode_pair", { url: server.url, code: "123456" })
  expect(code).toHaveValue("")
  expect(localStorage.length).toBe(0)
})

it("tests an existing server and returns to local mode without needing its API", async () => {
  native()
  const invoke = vi.fn(async (command: string) => {
    if (command === "server_mode_status") return server
    if (command === "server_mode_test") return { ok: true }
    return local
  })
  render(<ServerModeSettings invokeCommand={invoke as unknown as TauriInvoke} />)
  fireEvent.click(await screen.findByRole("button", { name: "Testar conexão" }))
  await screen.findByText("Conexão com o servidor confirmada.")
  expect(invoke).toHaveBeenCalledWith("server_mode_test", {})
  fireEvent.click(screen.getByRole("button", { name: "Voltar ao modo local" }))
  await screen.findByText("O touri vai reiniciar no modo local.")
  expect(invoke).toHaveBeenCalledWith("server_mode_local", {})
})

it("offers local recovery even when reading native mode fails with a locked vault", async () => {
  native()
  const invoke = vi.fn(async (command: string) => {
    if (command === "server_mode_status") throw new Error("VAULT_UNAVAILABLE")
    return local
  })
  render(<ServerModeSettings invokeCommand={invoke as unknown as TauriInvoke} />)
  expect(await screen.findByRole("alert")).toHaveTextContent("Desbloqueie-o")
  fireEvent.click(screen.getByRole("button", { name: "Voltar ao modo local" }))
  await screen.findByText("O touri vai reiniciar no modo local.")
  expect(invoke).toHaveBeenCalledWith("server_mode_local", {})
  expect(screen.queryByText("VAULT_UNAVAILABLE")).not.toBeInTheDocument()
})

it("keeps server recovery reachable after startup fails and never restarts a local sidecar", async () => {
  native()
  const invoke = vi.fn(async (command: string) => {
    if (command === "server_mode_status") return server
    if (command === "server_mode_local") return local
    throw new Error("VAULT_UNAVAILABLE")
  })
  render(<App kernel={{ services: { invoke: invoke as unknown as TauriInvoke } }} />)
  expect(await screen.findByText("Servidor offline. Tentando reconectar…")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: /Tentar novamente/ }))
  await waitFor(() =>
    expect(invoke.mock.calls.filter(([command]) => command === "sidecar_endpoint").length).toBeGreaterThan(1),
  )
  expect(invoke).not.toHaveBeenCalledWith("sidecar_restart", {})
  fireEvent.click(screen.getByRole("button", { name: "Usar um servidor touri" }))
  fireEvent.click(await screen.findByRole("button", { name: "Voltar ao modo local" }))
  await screen.findByText("O touri vai reiniciar no modo local.")
})

it.each([server, { mode: "server", url: null } as const])(
  "waits for native mode before mounting destination-scoped UI (%j)",
  async (status) => {
    native()
    let resolve: ((value: typeof status) => void) | undefined
    const invoke = vi.fn(
      () =>
        new Promise<typeof status>((done) => {
          resolve = done
        }),
    ) as unknown as TauriInvoke
    let mountedScope: string | null | undefined
    const Probe = () => {
      mountedScope = getStorageScope()
      return <p>Workspace</p>
    }
    render(
      <ServerModeProvider invoke={invoke}>
        <Probe />
      </ServerModeProvider>,
    )
    expect(screen.queryByText("Workspace")).not.toBeInTheDocument()
    resolve?.(status)
    await screen.findByText("Workspace")
    expect(mountedScope).toBe(status.url ?? "https://unavailable.invalid")
  },
)

it("applies the pending cold-start target after server mode loads and acknowledges that request", async () => {
  native()
  const api = createMockApi()
  const pending = { requestId: 3, bot: "bot-onb", thread: null }
  const invoke = vi.fn(async (command: string) => {
    if (command === "server_mode_status") return server
    if (command === "deep_link_pending") return pending
    return {}
  })
  render(<App kernel={{ services: { api, invoke: invoke as unknown as TauriInvoke } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  expect(screen.getByText("Modo servidor")).toHaveAttribute("title", server.url)
  expect(screen.queryByText("Local · grátis")).not.toBeInTheDocument()
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("deep_link_ack", { requestId: 3 }))
})

it("authorizes the saved server account through the native vault and tests the connection again", async () => {
  native()
  let authorize: (() => void) | undefined
  const authorization = new Promise<void>((resolve) => {
    authorize = resolve
  })
  vi.mocked(nativeInvoke).mockReturnValueOnce(authorization)
  const invoke = vi.fn(async (command: string) => (command === "server_mode_status" ? server : { ok: true }))
  // Flush the status response and the vault button's mount effect before authorizing.
  await act(async () => {
    render(
      <ServerModeSettings
        invokeCommand={invoke as unknown as TauriInvoke}
        connectionErrorCode="VAULT_ACCESS_REQUIRED"
      />,
    )
  })

  fireEvent.click(screen.getByRole("button", { name: "Permitir acesso ao cofre" }))

  expect(screen.getByRole("button", { name: "Aguardando permissão do macOS…" })).toBeDisabled()
  expect(nativeInvoke).toHaveBeenCalledExactlyOnceWith("vault_authorize", {
    account: `server-mode/${server.url}`,
  })
  expect(invoke).not.toHaveBeenCalledWith("server_mode_test", {})
  await act(async () => authorize?.())

  expect(screen.getByText("Conexão com o servidor confirmada.")).toBeVisible()
  expect(invoke.mock.calls.filter(([command]) => command === "server_mode_test")).toEqual([["server_mode_test", {}]])
})

it("hides the Mac folder chooser and disables the personal browser in server mode", async () => {
  native()
  const invoke = vi.fn(async () => server) as unknown as TauriInvoke
  const api = createMockApi()
  render(
    <ServerModeProvider invoke={invoke}>
      <FolderPicker api={api} invokeCommand={invoke} onSelect={vi.fn()} onClose={vi.fn()} />
      <BotBrowserPicker value="touri" machine="local" onChange={vi.fn()} />
    </ServerModeProvider>,
  )
  await screen.findByRole("dialog", { name: "Pastas no servidor" })
  expect(screen.queryByRole("button", { name: "Escolher no computador…" })).not.toBeInTheDocument()
  expect(screen.getByRole("combobox", { name: t("Bot browser") }).querySelector('option[value="local"]')).toBeDisabled()
  await waitFor(() => expect(screen.getByText(/Seu navegador pessoal fica indisponível/)).toBeVisible())
})

it.each(["local", "vm"] as const)(
  "preserves server VM permissions without exposing Mac control (%s)",
  async (machine) => {
    native()
    const api = createMockApi()
    const base = api.getState().bots[0]
    if (!base) throw new Error("Missing bot fixture")
    const bot = { ...base, machine, computerUse: true, mainThreadId: "thread-mark" }
    const originalRequest = api.request
    const grant = vi.fn(async (_input: unknown) => ({ grantId: "grant-server", expiresAt: Date.now() + 1_800_000 }))
    api.request = (async (route, input, path) =>
      route === "POST /computer/grants" ? grant(input) : originalRequest(route, input, path)) as ApiRequest
    const invoke = vi.fn(async () => server) as unknown as TauriInvoke
    render(
      <ServerModeProvider invoke={invoke}>
        <BotSettingsModal
          api={api}
          bot={bot}
          settings={null}
          projects={[]}
          routines={[]}
          actions={{ updateBot: vi.fn() } as unknown as WorkspaceActions}
          initialSection="computer"
          onClose={vi.fn()}
        />
      </ServerModeProvider>,
    )
    await screen.findByRole("tabpanel", { name: "Computador" })
    if (machine === "vm") expect(screen.getByRole("switch", { name: /^Controle do computador/ })).toBeVisible()
    else expect(screen.queryByRole("switch", { name: /^Controle do computador/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("switch", { name: new RegExp(t("Allow host computer use")) })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("tab", { name: "Permissões" }))
    if (machine === "vm") {
      fireEvent.click(await screen.findByRole("button", { name: "Permitir controle do computador" }))
      await screen.findByText(/Permitido até/)
      expect(grant).toHaveBeenCalledWith({ botId: bot.id, threadId: "thread-mark", minutes: 30 })
    } else expect(screen.queryByRole("button", { name: "Permitir controle do computador" })).not.toBeInTheDocument()
    expect(nativeInvoke).not.toHaveBeenCalledWith("permissions_request", expect.anything())
  },
)

it("hides client Mac permission requests in server app preferences", async () => {
  native()
  const invoke = vi.fn(async () => server) as unknown as TauriInvoke
  render(
    <ServerModeProvider invoke={invoke}>
      <SettingsModal settings={null} initialSection="privacy" onSave={vi.fn()} onClose={vi.fn()} />
    </ServerModeProvider>,
  )
  fireEvent.click(await screen.findByText("Dados, permissões e conexões"))
  expect(screen.queryByRole("heading", { name: "Permitir que um bot controle o Mac" })).not.toBeInTheDocument()
  expect(nativeInvoke).not.toHaveBeenCalledWith("permissions_status")
})

it("keeps native error details private and translates recovery guidance in both languages", () => {
  expect(serverModeError("SERVER_URL_INVALID")).toBe(
    t("Use um endereço HTTPS do seu servidor touri. HTTP só é permitido neste computador."),
  )
  expect(serverModeError("SERVER_PAIRING_REQUIRED")).toContain("Gere outro código")
  expect(serverModeError("SERVER_CONNECTION_FAILED")).toContain("Confira o endereço")
  expect(t("Voltar ao modo local", {}, "en")).toBe("Return to local mode")
  expect(t("Servidor offline. Tentando reconectar…", {}, "en")).toBe("Server offline. Trying to reconnect…")
})

it("keeps server mode actions independent of unsaved server preferences while offline", async () => {
  native()
  const invoke = vi.fn(async () => server) as unknown as TauriInvoke
  render(
    <SettingsModal
      initialSection="advanced"
      invokeCommand={invoke}
      settings={null}
      onSave={vi.fn()}
      onClose={vi.fn()}
    />,
  )
  await screen.findByRole("button", { name: "Voltar ao modo local" })
  expect(screen.queryByRole("button", { name: t("Save preferences") })).not.toBeInTheDocument()
})

it("does not open a server preview URL against the Mac loopback interface", async () => {
  native()
  const invoke = vi.fn(async () => server) as unknown as TauriInvoke
  render(
    <ServerModeProvider invoke={invoke}>
      <PreviewPane
        preview={{
          projectId: "project-test",
          processId: null,
          url: "http://127.0.0.1:18821",
          port: 18821,
          label: "Teste",
        }}
        modalOpen={false}
        invokeCommand={invoke}
        onOpenAgentBrowser={vi.fn()}
      />
    </ServerModeProvider>,
  )
  await screen.findByText("Este preview está no servidor. Peça ao bot para abri-lo no navegador do servidor.")
  expect(invoke).not.toHaveBeenCalledWith("preview_show", expect.anything())
})

it("keeps local recovery usable while the first server connection is still pending", async () => {
  native()
  const invoke = vi.fn(async (command: string) => {
    if (command === "server_mode_status") return server
    if (command === "sidecar_endpoint") return new Promise(() => undefined)
    if (command === "server_mode_local") return local
    return null
  })
  render(<App kernel={{ services: { invoke: invoke as unknown as TauriInvoke } }} />)
  await screen.findByText("Conectando ao servidor…")
  fireEvent.click(screen.getByRole("button", { name: "Usar um servidor touri" }))
  fireEvent.click(await screen.findByRole("button", { name: "Voltar ao modo local" }))
  await screen.findByText("O touri vai reiniciar no modo local.")
  expect(invoke).toHaveBeenCalledWith("server_mode_local", {})
  expect(invoke).not.toHaveBeenCalledWith("sidecar_restart", {})
})

it("describes the viewing device consistently in the server access summary", async () => {
  native()
  vi.mocked(nativeInvoke).mockResolvedValue(server)

  render(
    <ServerModeProvider>
      <BotAccessSummary machine="local" access="workspace-write" approvals="on-request" />
    </ServerModeProvider>,
  )

  const summary = await screen.findByText(/trabalha no servidor escolhido; não pode acessar os arquivos deste aparelho/)

  expect(summary).toBeVisible()
})
