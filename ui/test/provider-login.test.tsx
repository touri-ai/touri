import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import type { ApiRoutes, Message, ProviderLoginFlow } from "@touri/contracts"
import { createRef } from "react"
import { afterEach, expect, it, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { Composer } from "../src/components/Composer"
import { BotCreateModal } from "../src/components/Modals"
import { ProviderLogin } from "../src/components/ProviderLogin"
import { ApiError } from "../src/errors"
import { t } from "../src/i18n"
import { useWorkspace } from "../src/useWorkspace"

afterEach(() => vi.useRealTimers())
const fixture = (state: ProviderLoginFlow["state"] = "idle") => {
  const api = createMockApi()
  const original = api.request
  const flows = new Map<string, ProviderLoginFlow>()
  const request = vi.fn(async (route: string, input: Record<string, string>, path?: Record<string, string>) => {
    if (route === "GET /bots/:id/provider-login/flow")
      return flows.get(input.provider ?? "codex") ?? { provider: input.provider, state }
    if (route === "POST /bots/:id/provider-login/flow") {
      const flow: ProviderLoginFlow = {
        provider: input.provider as ProviderLoginFlow["provider"],
        state: input.action === "start" ? "waiting" : input.action === "cancel" ? "cancelled" : "ready",
      }
      flows.set(input.provider ?? "codex", flow)
      return flow
    }
    return original(route as keyof ApiRoutes, input as never, path)
  })
  api.request = request as ApiRequest
  return {
    api,
    request,
    setFlow: (value: ProviderLoginFlow) => {
      flows.set(value.provider, value)
    },
  }
}

it("starts OAuth automatically, polls the device code and cancels without restarting", async () => {
  const f = fixture()
  render(<ProviderLogin api={f.api} botId="bot" provider="codex" onConfigured={vi.fn()} />)
  await screen.findByText("Aguardando login no navegador…")
  expect(f.request).toHaveBeenCalledWith(
    "POST /bots/:id/provider-login/flow",
    { provider: "codex", action: "start" },
    { id: "bot" },
  )
  expect(document.querySelector('input[type="password"]')).toBeNull()
  vi.useFakeTimers()
  f.setFlow({
    provider: "codex",
    state: "waiting",
    deviceCode: "ABCD-EFGH",
    verificationUrl: "https://auth.openai.com/codex/device",
  })
  // Install a new polling cycle under fake timers.
  fireEvent.click(screen.getByRole("button", { name: "Cancelar login" }))
  await act(async () => {})
  expect(screen.getByText("Login cancelado.")).toBeVisible()
  const starts = f.request.mock.calls.filter(([, input]) => input.action === "start")
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(f.request.mock.calls.filter(([, input]) => input.action === "start")).toHaveLength(starts.length)
})

it("stops retrying a temporary login failure after its view closes", async () => {
  const f = fixture("host-available")
  const original = f.api.request
  let attempts = 0
  f.api.request = (async (route, input, path) => {
    if (route === "POST /bots/:id/provider-login/flow" && (input as { action: string }).action === "use-host") {
      attempts++
      throw new ApiError(503, "unavailable", "TOURI-E1009")
    }
    return original(route, input, path)
  }) as ApiRequest
  const view = render(<ProviderLogin api={f.api} botId="bot" provider="codex" onConfigured={vi.fn()} />)
  const button = await screen.findByRole("button", { name: "Usar login deste servidor" })
  vi.useFakeTimers()
  await act(async () => fireEvent.click(button))
  expect(attempts).toBe(1)
  view.unmount()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(attempts).toBe(1)
})

it.each(["mac", "server"] as const)("offers the %s host login first and connects with one click", async (host) => {
  const f = fixture("host-available")
  f.setFlow({ provider: "codex", state: "host-available", host })
  const location = host === "mac" ? "Mac" : "servidor"
  const configured = vi.fn()
  render(<ProviderLogin api={f.api} botId="bot" provider="codex" onConfigured={configured} />)
  await screen.findByRole("button", { name: `Usar login deste ${location}` })
  expect(screen.getByText(`Há um login disponível neste ${location}.`)).toBeVisible()
  expect(f.request.mock.calls.some(([, input]) => input.action === "start")).toBe(false)
  expect(f.request.mock.calls.some(([route]) => route === "GET /bots/:id/provider-login")).toBe(false)
  fireEvent.click(screen.getByRole("button", { name: `Usar login deste ${location}` }))
  await waitFor(() => expect(configured).toHaveBeenCalledOnce())
  expect(f.request).toHaveBeenCalledWith(
    "POST /bots/:id/provider-login/flow",
    { provider: "codex", action: "use-host" },
    { id: "bot" },
  )
})

it("uses server copy when an older sidecar omits the host context", async () => {
  const f = fixture("host-available")
  render(<ProviderLogin api={f.api} botId="bot" provider="codex" onConfigured={vi.fn()} />)
  await screen.findByRole("button", { name: "Usar login deste servidor" })
})

it.each(["idle", "waiting", "cancelled", "error", "ready"] as const)(
  "does not offer host import when the sidecar reports %s",
  async (state) => {
    const f = fixture(state)
    render(<ProviderLogin api={f.api} botId="bot" provider="codex" onConfigured={vi.fn()} />)
    await waitFor(() => expect(f.request).toHaveBeenCalled())
    expect(screen.queryByRole("button", { name: /^Usar login deste/ })).toBeNull()
    expect(f.request.mock.calls.some(([, input]) => input.action === "use-host")).toBe(false)
  },
)

it.each([
  ["Há um login disponível neste Mac.", "Há um login disponível neste Mac.", "A login is available on this Mac."],
  ["Usar login deste Mac", "Usar login deste Mac", "Use this Mac’s login"],
  [
    "Há um login disponível neste servidor.",
    "Há um login disponível neste servidor.",
    "A login is available on this server.",
  ],
  ["Usar login deste servidor", "Usar login deste servidor", "Use this server’s login"],
] as const)("translates host login copy: %s", (key, portuguese, english) => {
  expect(t(key, {}, "pt-BR")).toBe(portuguese)
  expect(t(key, {}, "en")).toBe(english)
})

it("keeps paste hidden and does not clear a rejected draft credential", async () => {
  const f = fixture("cancelled")
  const original = f.api.request
  f.api.request = (async (route, input, path) => {
    if (route === "POST /bots/:id/provider-login/flow" && (input as { action?: string }).action === "paste")
      throw new Error("vault unavailable")
    return original(route, input, path)
  }) as ApiRequest
  const configured = vi.fn()
  render(
    <ProviderLogin
      api={f.api}
      botId="draft-00000000-0000-4000-8000-000000000000"
      provider="codex"
      onConfigured={configured}
    />,
  )
  expect(document.querySelector('input[type="password"]')).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Colar token manualmente" }))
  const input = screen.getByLabelText("Login JSON do Codex")
  fireEvent.change(input, { target: { value: "synthetic-secret" } })
  fireEvent.click(screen.getByRole("button", { name: "Salvar login no cofre" }))
  await screen.findByRole("alert")
  expect(input).toHaveValue("synthetic-secret")
  expect(configured).not.toHaveBeenCalled()
  expect(document.body.textContent).not.toContain("synthetic-secret")
})

it("composer blocks submission until login succeeds and shows the device challenge", async () => {
  vi.useFakeTimers()
  const f = fixture("waiting")
  f.setFlow({ provider: "codex", state: "waiting", deviceCode: "ABCD-EFGH" })
  const bot = f.api.getState().bots[0]
  if (!bot) throw new Error("Missing fixture")
  const send = vi.fn().mockResolvedValue(undefined)
  const openLogin = vi.fn()
  render(
    <Composer
      api={f.api}
      bot={bot}
      threadId="thread"
      parentId={null}
      draft="Primeira mensagem"
      onDraft={vi.fn()}
      inputRef={createRef()}
      activeRun={null}
      queuedCount={0}
      onSend={send}
      onCancel={vi.fn()}
      onOpenProviderLogin={openLogin}
      notice={{
        bot,
        latestReply: {
          runId: "failed-login-run",
          status: "failed",
          parts: [{ type: "notice", level: "error", text: "cli_auth: login ausente" }],
        } as Message,
        machine: undefined,
        onRetry: vi.fn(),
      }}
    />,
  )
  await act(async () => {})
  expect(screen.getByText("ABCD-EFGH")).toBeVisible()
  expect(screen.queryByText(/Entre no .+ para continuar/)).toBeNull()
  expect(screen.queryByRole("button", { name: "Entrar no provedor" })).toBeNull()
  const button = screen.getByRole("button", { name: "Enviar" })
  expect(button).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Colar token manualmente" }))
  expect(openLogin).toHaveBeenCalledOnce()
  fireEvent.submit(screen.getByRole("form", { name: "Compor mensagem" }))
  expect(send).not.toHaveBeenCalled()
  f.setFlow({ provider: "codex", state: "ready" })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(button).toBeEnabled()
  fireEvent.click(button)
  expect(send).toHaveBeenCalledOnce()
})

it.each(["mac", "server"] as const)("composer identifies the %s host and waits for explicit import", async (host) => {
  const f = fixture("host-available")
  const bot = f.api.getState().bots[0]
  if (!bot) throw new Error("Missing fixture")
  f.setFlow({ provider: bot.provider, state: "host-available", host })
  const location = host === "mac" ? "Mac" : "servidor"
  const send = vi.fn().mockResolvedValue(undefined)
  render(
    <Composer
      api={f.api}
      bot={bot}
      threadId="thread"
      parentId={null}
      draft="Primeira mensagem"
      onDraft={vi.fn()}
      inputRef={createRef()}
      activeRun={null}
      queuedCount={0}
      onSend={send}
      onCancel={vi.fn()}
    />,
  )
  await screen.findByText(`Há um login disponível neste ${location}.`)
  const submit = screen.getByRole("button", { name: "Enviar" })
  expect(submit).toBeDisabled()
  expect(f.request.mock.calls.some(([, input]) => input.action === "start" || input.action === "use-host")).toBe(false)
  fireEvent.click(screen.getByRole("button", { name: `Usar login deste ${location}` }))
  await waitFor(() => expect(submit).toBeEnabled())
  expect(send).not.toHaveBeenCalled()
  expect(f.request).toHaveBeenCalledWith(
    "POST /bots/:id/provider-login/flow",
    { provider: bot.provider, action: "use-host" },
    { id: bot.id },
  )
  await act(async () => {
    fireEvent.click(submit)
  })
  expect(send).toHaveBeenCalledOnce()
})

it("opens the device login page once across simultaneous composer and settings views", async () => {
  const f = fixture("waiting")
  const open = vi.spyOn(window, "open").mockImplementation(() => null)
  f.setFlow({ provider: "codex", state: "waiting", verificationUrl: "https://auth.openai.com/codex/device" })
  const { unmount } = render(
    <>
      <ProviderLogin api={f.api} botId="bot" provider="codex" onConfigured={vi.fn()} />
      <ProviderLogin api={f.api} botId="bot" provider="codex" onConfigured={vi.fn()} />
    </>,
  )
  await waitFor(() =>
    expect(open).toHaveBeenCalledExactlyOnceWith(
      "https://auth.openai.com/codex/device",
      "_blank",
      "noopener,noreferrer",
    ),
  )
  unmount()
  open.mockRestore()
})

it("shows the Claude code prompt and error without opening a second browser page", async () => {
  const f = fixture("waiting")
  const open = vi.spyOn(window, "open").mockImplementation(() => null)
  const url = "https://claude.com/cai/oauth/authorize?client_id=synthetic&state=synthetic-state"
  const codeError = "Código inválido. Copie o código completo exibido no navegador e tente novamente."
  f.setFlow({ provider: "claude", state: "waiting", needsCode: true, verificationUrl: url, codeError })
  const configured = vi.fn()
  render(<ProviderLogin api={f.api} botId="bot" provider="claude" onConfigured={configured} />)
  const input = await screen.findByLabelText("Código exibido no navegador")
  expect(input).toHaveAttribute("type", "text")
  expect(input).toHaveAttribute("aria-invalid", "true")
  expect(screen.getByRole("alert")).toHaveTextContent(codeError)
  expect(screen.getByRole("link", { name: "Abrir página de login" })).toHaveAttribute("href", url)
  expect(open).not.toHaveBeenCalled()
  expect(screen.getByRole("button", { name: "Enviar código" })).toBeDisabled()
  fireEvent.click(screen.getByRole("link", { name: "Abrir página de login" }))
  expect(open).toHaveBeenCalledExactlyOnceWith(url, "_blank", "noopener,noreferrer")
  fireEvent.change(input, { target: { value: "synthetic-browser-code" } })
  fireEvent.click(screen.getByRole("button", { name: "Enviar código" }))
  await waitFor(() => expect(configured).toHaveBeenCalledOnce())
  expect(f.request).toHaveBeenCalledWith(
    "POST /bots/:id/provider-login/flow",
    { provider: "claude", action: "code", value: "synthetic-browser-code" },
    { id: "bot" },
  )
  expect(document.body.textContent).not.toContain("synthetic-browser-code")
  open.mockRestore()
})

it("keeps a Claude code for retry when its submission fails", async () => {
  const f = fixture("waiting")
  f.setFlow({ provider: "claude", state: "waiting", needsCode: true })
  const original = f.api.request
  f.api.request = (async (route, input, path) => {
    if (route === "POST /bots/:id/provider-login/flow" && (input as { action?: string }).action === "code")
      throw new Error("synthetic failure")
    return original(route, input, path)
  }) as ApiRequest
  render(<ProviderLogin api={f.api} botId="bot" provider="claude" onConfigured={vi.fn()} />)
  const input = await screen.findByLabelText("Código exibido no navegador")
  fireEvent.change(input, { target: { value: "synthetic-browser-code" } })
  fireEvent.keyDown(input, { key: "Enter" })
  await screen.findByRole("alert")
  expect(input).toHaveValue("synthetic-browser-code")
  expect(screen.getByRole("button", { name: "Enviar código" })).toBeEnabled()
})

it("creation starts the selected provider before creating a bot and cancels on close", async () => {
  const f = fixture()
  const create = vi.fn()
  const view = render(<BotCreateModal api={f.api} onCreate={create} onClose={vi.fn()} />)
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Pesquisa" } })
  fireEvent.click(await screen.findByRole("button", { name: "Claude Code", exact: true }))
  await screen.findByText("Aguardando login no navegador…")
  await waitFor(() =>
    expect(f.request).toHaveBeenCalledWith(
      "POST /bots/:id/provider-login/flow",
      { provider: "claude", action: "start" },
      { id: expect.stringMatching(/^draft-/) },
    ),
  )
  expect(create).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Colar token manualmente" }))
  expect(screen.getByText(/No Terminal deste Mac, execute claude setup-token/)).toHaveTextContent(
    "somente por este bot, na máquina escolhida para ele",
  )
  expect(screen.queryByText(/execuções deste bot na VM/)).not.toBeInTheDocument()
  view.unmount()
  expect(f.request).toHaveBeenCalledWith(
    "POST /bots/:id/provider-login/flow",
    { provider: "claude", action: "cancel" },
    { id: expect.stringMatching(/^draft-/) },
  )
})

it("relays OpenCode menu navigation to its own CLI", async () => {
  const f = fixture("waiting")
  f.setFlow({ provider: "opencode", state: "waiting", prompt: { kind: "provider", choice: "OpenAI" } })
  render(<ProviderLogin api={f.api} botId="bot" provider="opencode" onConfigured={vi.fn()} />)
  await screen.findByText("OpenAI")
  fireEvent.click(screen.getByRole("button", { name: "Confirmar opção" }))
  await waitFor(() =>
    expect(f.request).toHaveBeenCalledWith(
      "POST /bots/:id/provider-login/flow",
      { provider: "opencode", action: "input", input: "enter" },
      { id: "bot" },
    ),
  )
})

it("opens the created bot when adoption succeeded but its response was lost", async () => {
  const api = createMockApi()
  const original = api.request
  let denied = true
  const request = vi.fn(async (route: keyof ApiRoutes, input: never, path?: Record<string, string>) => {
    if (route === "POST /bots/:id/provider-login/flow" && denied) {
      denied = false
      await original(route, input, path)
      throw new ApiError(503, "unavailable", "TOURI-E1009")
    }
    return original(route, input, path)
  })
  api.request = request as ApiRequest
  const { result } = renderHook(() => useWorkspace(api, false))
  const input = { provider: "codex" as const, name: "Pesquisa" }
  await act(async () => {
    await expect(result.current.actions.createBot(input, "draft-test")).resolves.toEqual({ loginReady: true })
  })
  expect(request.mock.calls.filter(([route]) => route === "POST /bots")).toHaveLength(1)
  expect(request).toHaveBeenCalledWith(
    "POST /bots/:id/provider-login/flow",
    { provider: "codex", action: "adopt", draftId: "draft-test" },
    { id: result.current.data.selectedBotId },
  )
  expect(result.current.data.selectedThreadId).toBe(result.current.data.bots.at(-1)?.mainThreadId)
})
