import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { Bot, MachineState } from "@touri/contracts"
import { afterEach, expect, test, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { BotComputer } from "../src/components/BotComputer"
import { BotDetails } from "../src/components/BotDetails"
import { BotPanel } from "../src/components/BotPanel"
import { computerKillSwitchEvent } from "../src/computerKillSwitch"
import { readWorkspaceState } from "../src/workspaceState"

vi.mock("../src/features/desktop/DesktopPanel", () => ({
  DesktopPanel: ({
    paused,
    onControlChange,
  }: {
    bot: Bot
    paused: boolean
    onControlChange: (active: boolean) => void
  }) => (
    <section aria-label="Desktop de teste">
      <button type="button" disabled={paused} onClick={() => onControlChange(true)}>
        Assumir controle
      </button>
      <span>Acompanhar a tela</span>
    </section>
  ),
}))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const machine = (
  status: MachineState["status"],
  progress: string | null = null,
  error: string | null = null,
): MachineState => ({ botId: "bot-mark", status, progress, error, memoryMb: 2048, createdMs: null, startMs: null })
const fixture = async () => {
  const api = createMockApi()
  const { bot } = await api.request(
    "PATCH /bots/:id",
    { machine: "vm", computerUse: false, roleLine: null },
    { id: "bot-mark" },
  )
  return { api, bot }
}

test.each([
  ["read-only", "never", "Somente leitura"],
  ["full", "never", "Acesso total"],
  ["workspace-write", "on-request", "Pede permissão antes de mudar arquivos"],
] as const)("details explain %s access with %s approvals", async (access, approvals, sentence) => {
  const { bot } = await fixture()
  const onSettings = vi.fn()
  const onPermissions = vi.fn()
  render(
    <BotDetails bot={{ ...bot, access, approvals }} onSettings={onSettings} onPermissions={onPermissions}>
      {null}
    </BotDetails>,
  )
  expect(screen.getByText(`${sentence}; só no computador isolado.`)).toBeVisible()
  expect(screen.getByText("Trabalha no próprio computador.")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: /^Modelo: Codex/ }))
  expect(onSettings).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole("button", { name: "Ajustar permissões" }))
  expect(onPermissions).toHaveBeenCalledOnce()
})

test("panel tabs are accessible from arrows and save the label", async () => {
  const { api, bot } = await fixture()
  const role = vi.fn(async () => {})
  render(
    <BotPanel
      api={api}
      bot={bot}
      routines={[]}
      paused={false}
      expanded={false}
      onExpand={vi.fn()}
      onWindow={vi.fn()}
      onClose={vi.fn()}
      onSettings={vi.fn()}
      onRoutines={vi.fn()}
      onPermissions={vi.fn()}
      onRole={role}
    />,
  )
  const input = screen.getByRole("textbox", { name: "O que ele faz" })
  expect(input).toHaveAttribute("placeholder", "Adicionar uma função")
  fireEvent.change(input, { target: { value: "Pesquisa de produto" } })
  fireEvent.blur(input)
  await waitFor(() => expect(role).toHaveBeenCalledWith("Pesquisa de produto"))
  const details = screen.getByRole("tab", { name: "Detalhes" })
  expect(details).toHaveAttribute("aria-selected", "true")
  fireEvent.keyDown(details, { key: "ArrowRight" })
  expect(screen.getByRole("tab", { name: "Biblioteca" })).toHaveFocus()
  expect(await screen.findByRole("button", { name: /notas.md.*KB/ })).toBeVisible()
  fireEvent.keyDown(screen.getByRole("tab", { name: "Biblioteca" }), { key: "End" })
  expect(screen.getByRole("tab", { name: "Computador" })).toHaveFocus()
  expect(await screen.findByRole("button", { name: "Ligar computador" })).toBeVisible()
})

test("panel visibility persists independently per bot and survives remount", async () => {
  const api = createMockApi()
  const view = render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  expect(screen.queryByRole("complementary", { name: "Painel de mark" })).toBeNull()
  expect(screen.getByRole("button", { name: "Painel do bot" })).toHaveAttribute("aria-expanded", "false")
  fireEvent.click(screen.getByRole("button", { name: "Painel do bot" }))
  await screen.findByRole("complementary", { name: /^Painel de / })
  expect(screen.getByRole("complementary", { name: "Painel de mark" })).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Fechar painel do bot" }))
  expect(readWorkspaceState().panelsByBot?.["bot-mark"]).toBe(false)
  fireEvent.click(
    document.querySelector<HTMLButtonElement>('[data-bot-id="bot-onb"].bot-row') ??
      (screen.getAllByRole("button", { name: /onb/ })[0] as HTMLElement),
  )
  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  expect(screen.queryByRole("complementary", { name: "Painel de onb" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Painel do bot" }))
  await screen.findByRole("complementary", { name: /^Painel de / })
  expect(screen.getByRole("complementary", { name: "Painel de onb" })).toBeVisible()
  expect(readWorkspaceState().panelsByBot?.["bot-onb"]).toBe(true)
  view.unmount()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  expect(screen.getByRole("complementary", { name: "Painel de onb" })).toBeVisible()
  fireEvent.click(screen.getAllByRole("button", { name: /mark/ })[0] as HTMLElement)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  expect(screen.queryByRole("complementary", { name: "Painel de mark" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Painel do bot" }))
  await screen.findByRole("complementary", { name: /^Painel de / })
  expect(screen.getByRole("complementary", { name: "Painel de mark" })).toBeVisible()
})

for (const status of ["stopped", "starting", "running", "error"] as const)
  test(`computer exposes ${status} and stage message`, async () => {
    const { api, bot } = await fixture()
    render(
      <BotComputer
        api={api}
        bot={bot}
        machine={machine(status, "Preparando a imagem Linux", status === "error" ? "Falha ao iniciar" : null)}
      />,
    )
    expect(screen.getByText("Preparando a imagem Linux")).toBeVisible()
    expect(
      screen.getByRole("button", {
        name: status === "running" ? "Acompanhar a tela" : status === "starting" ? "Preparando…" : "Ligar computador",
      }),
    ).toBeVisible()
    expect(screen.queryByRole("button", { name: "Interromper controle" })).toBeNull()
    expect(screen.queryByRole("region", { name: "Desktop de teste" })).toBeNull()
  })

test("computer warms with computer-open, starts view-only, gates shell/control and kills", async () => {
  const { api, bot } = await fixture()
  const view = render(<BotComputer api={api} bot={bot} machine={machine("running")} />)
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Acompanhar a tela" })))
  expect(api.calls).toContainEqual({
    route: "POST /bots/:id/machine/intent",
    input: { intent: "computer-open" },
    pathValues: { id: bot.id },
  })
  expect(screen.getByText("Acompanhar a tela")).toBeVisible()
  expect(screen.getByRole("button", { name: "Assumir controle" })).toBeEnabled()
  fireEvent.click(screen.getByRole("button", { name: "Terminal" }))
  expect(screen.getByText(/64 KB de saída/)).toBeVisible()
  expect(screen.queryByText(/KiB/)).toBeNull()
  expect(screen.getByLabelText("Comando na VM")).toBeDisabled()
  view.rerender(<BotComputer api={api} bot={{ ...bot, computerUse: true }} machine={machine("running")} />)
  fireEvent.change(screen.getByLabelText("Comando na VM"), { target: { value: "pwd" } })
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Executar" })))
  expect(screen.getByRole("log")).toHaveTextContent("/workspace")
  expect(screen.queryByRole("button", { name: "Interromper controle" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Área de trabalho" }))
  fireEvent.click(screen.getByRole("button", { name: "Assumir controle" }))
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Interromper controle" })))
  expect(api.calls.some((call) => call.route === "POST /computer/kill")).toBe(true)
  expect(screen.queryByLabelText("Comando na VM")).toBeNull()
})

test("native local machine explains host control instead of offering a VM", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {})
  const { api, bot } = await fixture()
  const permissions = vi.fn()
  render(<BotComputer api={api} bot={{ ...bot, machine: "local" }} onPermissions={permissions} />)
  expect(screen.getByRole("status")).toHaveTextContent("Controle desativado")
  expect(screen.queryByRole("button", { name: "Ligar computador" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Permissões do computador" }))
  expect(permissions).toHaveBeenCalled()
})

test("library opens markdown through the existing renderer, navigates folders and shows an empty state", async () => {
  const { api, bot } = await fixture()
  render(
    <BotPanel
      api={api}
      bot={bot}
      routines={[]}
      paused={false}
      expanded={false}
      onExpand={vi.fn()}
      onWindow={vi.fn()}
      onClose={vi.fn()}
      onSettings={vi.fn()}
      onRoutines={vi.fn()}
      onPermissions={vi.fn()}
      onRole={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole("tab", { name: "Biblioteca" }))
  fireEvent.click(await screen.findByRole("button", { name: /notas.md.*KB/ }))
  expect(await screen.findByRole("heading", { name: "Workspace do bot" })).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Voltar aos arquivos" }))
  fireEvent.click(screen.getByRole("button", { name: /documentos.*Pasta/ }))
  expect(await screen.findByText("Nenhum arquivo por aqui")).toBeVisible()
  expect(within(screen.getByRole("tabpanel")).getByRole("button", { name: /Pasta anterior/ })).toBeVisible()
})

test("a delayed warm response cannot reopen a computer after interruption", async () => {
  const { api, bot } = await fixture()
  let complete: ((value: { machine: MachineState }) => void) | undefined
  const request = api.request
  api.request = async (route, input, path) => {
    if (route === "POST /bots/:id/machine/intent" && (input as { intent: string }).intent === "computer-open")
      return (await new Promise<{ machine: MachineState }>((resolve) => {
        complete = resolve
      })) as never
    return request(route, input, path)
  }
  render(<BotComputer api={api} bot={bot} machine={machine("running")} />)
  fireEvent.click(screen.getByRole("button", { name: "Acompanhar a tela" }))
  expect(screen.queryByRole("button", { name: "Interromper controle" })).toBeNull()
  fireEvent(window, new Event(computerKillSwitchEvent))
  await act(async () => complete?.({ machine: machine("running") }))
  expect(screen.queryByRole("region", { name: "Desktop de teste" })).toBeNull()
})

test("a cold computer opens when its running event arrives after the request timeout", async () => {
  const { api, bot } = await fixture()
  const request = api.request
  api.request = async (route, input, path) => {
    if (route === "POST /bots/:id/machine/intent") throw new Error("A inicialização está demorando")
    return request(route, input, path)
  }
  const view = render(<BotComputer api={api} bot={bot} machine={machine("stopped")} />)
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Ligar computador" })))
  view.rerender(<BotComputer api={api} bot={bot} machine={machine("running")} />)
  expect(screen.getByRole("region", { name: "Desktop de teste" })).toBeVisible()
  expect(screen.queryByRole("alert")).toBeNull()
})

test("computer boot gives immediate feedback and a starting response is progress, not an error", async () => {
  const { api, bot } = await fixture()
  const request = api.request
  let finish: ((value: { machine: MachineState }) => void) | undefined
  api.request = async (route, input, path) => {
    if (route === "POST /bots/:id/machine/intent")
      return (await new Promise<{ machine: MachineState }>((resolve) => {
        finish = resolve
      })) as never
    return request(route, input, path)
  }
  const view = render(<BotComputer api={api} bot={bot} machine={machine("stopped")} />)
  fireEvent.click(screen.getByRole("button", { name: "Ligar computador" }))
  expect(screen.getByRole("button", { name: "Ligando…" })).toBeDisabled()
  expect(screen.getByRole("progressbar")).toBeVisible()
  view.rerender(<BotComputer api={api} bot={bot} machine={machine("starting", "Preparando a imagem Linux…")} />)
  await act(async () => finish?.({ machine: machine("starting") }))
  expect(screen.getByRole("button", { name: "Preparando…" })).toBeDisabled()
  expect(screen.queryByRole("alert")).toBeNull()
  view.rerender(<BotComputer api={api} bot={bot} machine={machine("running")} />)
  expect(screen.getByRole("region", { name: "Desktop de teste" })).toBeVisible()
})

test("a stopped warm response gives an actionable error and machine cancellation is never a turn label", async () => {
  const { api, bot } = await fixture()
  const request = api.request
  api.request = async (route, input, path) => {
    if (route === "POST /bots/:id/machine/intent")
      return { machine: machine("error", null, "canceled: Turno cancelado") } as never
    return request(route, input, path)
  }
  render(<BotComputer api={api} bot={bot} machine={machine("error", null, "canceled: Turno cancelado")} />)
  expect(screen.queryByText(/Cancelado/i)).toBeNull()
  expect(screen.getAllByRole("status").find((node) => node.classList.contains("machine-chip"))).toHaveTextContent(
    "parado",
  )
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Ligar computador" })))
  expect(screen.getByRole("alert")).toHaveTextContent("O computador ainda não está pronto")
  expect(screen.queryByText(/Cancelado/i)).toBeNull()
  expect(screen.getByRole("button", { name: "Ligar computador" })).toBeEnabled()
})

test("inactivity pause explains the stopped machine and offers Ligar without an inactive kill switch", async () => {
  const { api, bot } = await fixture()
  render(<BotComputer api={api} bot={bot} machine={{ ...machine("stopped"), pauseReason: "inactivity" }} />)
  expect(screen.getAllByText("Máquina pausada por inatividade").length).toBeGreaterThan(0)
  expect(screen.queryByRole("button", { name: "Interromper controle" })).toBeNull()
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Ligar" })))
  expect(api.calls.some((call) => (call.input as { intent: string }).intent === "computer-open")).toBe(true)
})

test("local kill switch is visible only during active control of this bot", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {})
  const { api, bot } = await fixture()
  render(<BotComputer api={api} bot={{ ...bot, machine: "local", computerUse: true }} />)
  expect(screen.queryByRole("button", { name: "Interromper controle" })).toBeNull()
  act(() => api.emit({ type: "computer.state", active: true, botId: bot.id, grantId: null }))
  expect(screen.getByRole("button", { name: "Interromper controle" })).toBeVisible()
  act(() => api.emit({ type: "computer.state", active: false, botId: null, grantId: null }))
  expect(screen.queryByRole("button", { name: "Interromper controle" })).toBeNull()
})
