import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import type { ApiRoutes, Bot, Message, ProviderLoginFlow } from "@touri/contracts"
import { createRef, useState } from "react"
import { afterEach, expect, it, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { Composer } from "../src/components/Composer"
import { BotCreateModal, BotSettingsModal } from "../src/components/Modals"
import { ProviderLogin } from "../src/components/ProviderLogin"
import { ApiError } from "../src/errors"
import { t } from "../src/i18n"
import { useProviderLogin } from "../src/useProviderLogin"
import { useWorkspace, type WorkspaceActions } from "../src/useWorkspace"
import { chooseTeamAction } from "./workspaceNavigation"

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

it.each(["ready", "idle", "host-available", "cancelled", "error", "vault-locked"] as const)(
  "%s login does not poll at rest and refreshes when focus returns",
  async (state) => {
    vi.useFakeTimers()
    const f = fixture(state)
    const provider = f.api.getState().bots[0]?.provider
    if (!provider) throw new Error("Missing provider fixture")
    const hook = renderHook(() => useProviderLogin(f.api, "bot", provider, true, false))
    await act(async () => {})
    const reads = () => f.request.mock.calls.filter(([route]) => route === "GET /bots/:id/provider-login/flow").length
    expect(reads()).toBe(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(reads()).toBe(1)
    await act(async () => {
      fireEvent.focus(window)
    })
    expect(reads()).toBe(2)
    hook.unmount()
  },
)

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

it.each([true, false])(
  "recovers a pending login after a rejected status read and stops polling when ready (autoStart: %s)",
  async (autoStart) => {
    vi.useFakeTimers()
    const f = fixture(autoStart ? "idle" : "waiting")
    const request = f.api.request
    let reads = 0
    let rejectNextRead = false
    f.api.request = (async (route, input, path) => {
      if (route === "GET /bots/:id/provider-login/flow") {
        reads++
        if (rejectNextRead) {
          rejectNextRead = false
          throw new Error("temporary connection failure")
        }
      }
      return request(route, input, path)
    }) as ApiRequest
    const { result } = renderHook(() => useProviderLogin(f.api, "bot", "codex", true, autoStart))
    await act(async () => {})
    expect(result.current.flow?.state).toBe("waiting")
    const initialReads = reads
    rejectNextRead = true

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(reads).toBe(initialReads + 1)
    expect(result.current.flow?.state).toBe("waiting")
    expect(result.current.blocked).toBe(true)
    expect(result.current.error).not.toBeNull()

    f.setFlow({ provider: "codex", state: "ready" })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(reads).toBe(initialReads + 2)
    expect(result.current.flow?.state).toBe("ready")
    expect(result.current.blocked).toBe(false)
    expect(result.current.error).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(reads).toBe(initialReads + 2)
  },
)

it.each(["focus", "online"] as const)("refreshes a quiet login on %s without restarting it", async (event) => {
  vi.useFakeTimers()
  const f = fixture("cancelled")
  const hook = renderHook(() => useProviderLogin(f.api, "bot", "codex", true, false))
  await act(async () => {})
  const reads = () => f.request.mock.calls.filter(([route]) => route === "GET /bots/:id/provider-login/flow").length
  expect(reads()).toBe(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(reads()).toBe(1)
  f.setFlow({ provider: "codex", state: "ready" })
  await act(async () => {
    window.dispatchEvent(new Event(event))
  })
  expect(hook.result.current.flow?.state).toBe("ready")
  expect(reads()).toBe(2)
  expect(f.request.mock.calls.some(([route]) => route === "POST /bots/:id/provider-login/flow")).toBe(false)
  hook.unmount()
  await act(async () => {
    window.dispatchEvent(new Event(event))
  })
  expect(reads()).toBe(2)
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
  const button = await screen.findByRole("button", { name: "Usar login deste computador" })
  vi.useFakeTimers()
  await act(async () => fireEvent.click(button))
  expect(attempts).toBe(1)
  view.unmount()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(attempts).toBe(1)
})

it.each(["mac", "computer", "server"] as const)(
  "offers the %s host login first and connects with one click",
  async (host) => {
    const f = fixture("host-available")
    f.setFlow({ provider: "codex", state: "host-available", host: host === "mac" ? "mac" : "server", hostKind: host })
    const location = { mac: "Mac", computer: "computador", server: "servidor" }[host]
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
  },
)

it("uses computer copy when an older sidecar omits the host context", async () => {
  const f = fixture("host-available")
  render(<ProviderLogin api={f.api} botId="bot" provider="codex" onConfigured={vi.fn()} />)
  await screen.findByRole("button", { name: "Usar login deste computador" })
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

it("composer keeps an attempted message as a draft and sends it once login succeeds", async () => {
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
  expect(screen.getByRole("textbox", { name: "Código de login" })).toHaveValue("ABCD-EFGH")
  expect(screen.queryByText(/Entre no .+ para continuar/)).toBeNull()
  expect(screen.queryByRole("button", { name: "Entrar no provedor" })).toBeNull()
  const button = screen.getByRole("button", { name: "Enviar" })
  expect(button).toBeEnabled()
  expect(screen.queryByRole("button", { name: "Colar token manualmente" })).toBeNull()
  fireEvent.submit(screen.getByRole("form", { name: "Compor mensagem" }))
  expect(send).not.toHaveBeenCalled()
  f.setFlow({ provider: "codex", state: "ready" })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(button).toBeEnabled()
  expect(send).toHaveBeenCalledOnce()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(send).toHaveBeenCalledOnce()
})

it.each(["mac", "server"] as const)("composer identifies the %s host and waits for explicit import", async (host) => {
  const f = fixture("host-available")
  const bot = f.api.getState().bots[0]
  if (!bot) throw new Error("Missing fixture")
  f.setFlow({
    provider: bot.provider,
    state: "host-available",
    host: host === "mac" ? "mac" : "server",
    hostKind: host,
  })
  const location = { mac: "Mac", computer: "computador", server: "servidor" }[host]
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
  expect(submit).toBeEnabled()
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
  expect(screen.getByText(/No terminal da máquina escolhida para o bot, execute claude setup-token/)).toHaveTextContent(
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
    await expect(result.current.actions.createBot(input, "draft-test")).resolves.toMatchObject({
      loginReady: true,
      bot: { name: "Pesquisa" },
    })
  })
  expect(request.mock.calls.filter(([route]) => route === "POST /bots")).toHaveLength(1)
  expect(request).toHaveBeenCalledWith(
    "POST /bots/:id/provider-login/flow",
    { provider: "codex", action: "adopt", draftId: "draft-test" },
    { id: result.current.data.selectedBotId },
  )
  expect(result.current.data.selectedThreadId).toBe(result.current.data.bots.at(-1)?.mainThreadId)
})

it.each([false, true])("keeps the adopted VM login with event subscription %s", async (enabled) => {
  const api = createMockApi()
  const original = api.request
  api.request = (async (route, input, path) => {
    const result = await original(route, input, path)
    if (route === "POST /bots/:id/provider-login/flow" && (input as { action?: string }).action === "adopt") {
      await original("PATCH /bots/:id", { vmProviderLogin: true }, path)
    }
    return route === "POST /bots" ? structuredClone(result) : result
  }) as ApiRequest
  const { result } = renderHook(() => useWorkspace(api, enabled))
  if (enabled) await waitFor(() => expect(result.current.data.loading).toBe(false))
  await act(async () => {
    await result.current.actions.createBot({ name: "QA VM", provider: "codex", machine: "vm" }, "draft-test")
  })
  const bot = result.current.data.bots.find((bot) => bot.id === result.current.data.selectedBotId)
  expect(bot?.vmProviderLogin).toBe(true)
})

it("saving unrelated VM settings does not send a stale login flag after a bot update", async () => {
  const api = createMockApi()
  const original = api.getState().bots[0]
  if (!original) throw new Error("Missing bot")
  const initial: Bot = { ...original, provider: "codex", machine: "vm", browser: "machine", vmProviderLogin: false }
  const updateBot = vi.fn<WorkspaceActions["updateBot"]>(async () => {})
  const props = {
    api,
    projects: [],
    routines: [],
    capability: { available: true, reason: null, provider: null },
    initialSection: "computer",
    actions: { updateBot } as unknown as WorkspaceActions,
    onClose: vi.fn(),
    onOpenIntegrations: vi.fn(),
  }
  const view = render(<BotSettingsModal {...props} bot={initial} />)
  // A login flow can finish while the settings dialog is already open.
  view.rerender(<BotSettingsModal {...props} bot={{ ...initial, vmProviderLogin: true }} />)
  expect(screen.getByRole("switch", { name: /Usar meu login do Codex/ })).toBeChecked()
  fireEvent.click(screen.getByRole("switch", { name: /Navegador habilitado/ }))
  await waitFor(() => expect(updateBot).toHaveBeenCalledWith(initial.id, { browserEnabled: false }))
  const saveButton = screen.getByRole("button", { name: "Salvar configurações" })
  await waitFor(() => expect(saveButton).toBeEnabled())

  fireEvent.click(saveButton)
  await waitFor(() => expect(props.onClose).toHaveBeenCalled())
  expect(updateBot.mock.calls.at(-1)?.[1]).not.toHaveProperty("vmProviderLogin")
})

it("saving an explicit VM login opt-out still sends false", async () => {
  const api = createMockApi()
  const original = api.getState().bots[0]
  if (!original) throw new Error("Missing bot")
  const bot: Bot = { ...original, provider: "codex", machine: "vm", browser: "machine", vmProviderLogin: true }
  const updateBot = vi.fn<WorkspaceActions["updateBot"]>(async () => {})
  render(
    <BotSettingsModal
      bot={bot}
      projects={[]}
      routines={[]}
      capability={{ available: true, reason: null, provider: null }}
      initialSection="computer"
      actions={{ updateBot } as unknown as WorkspaceActions}
      onClose={vi.fn()}
      onOpenIntegrations={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole("switch", { name: /Usar meu login do Codex/ }))
  fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }))
  await waitFor(() =>
    expect(updateBot).toHaveBeenCalledWith(bot.id, expect.objectContaining({ vmProviderLogin: false })),
  )
})

const recoveringComposer = (
  f: ReturnType<typeof fixture>,
  onSend = vi.fn().mockResolvedValue(undefined),
  groupName?: string,
) => {
  const bot = f.api.getState().bots[0]
  if (!bot) throw new Error("Missing fixture")
  const Harness = ({ threadId = "first-thread" }: { threadId?: string }) => {
    const [draft, setDraft] = useState("Oi! Em uma linha, o que você faz?")
    return (
      <Composer
        api={f.api}
        bot={{ ...bot, machine: "vm" }}
        groupName={groupName}
        threadId={threadId}
        parentId={null}
        draft={draft}
        onDraft={setDraft}
        inputRef={createRef()}
        activeRun={null}
        queuedCount={0}
        onSend={onSend}
        onCancel={vi.fn()}
      />
    )
  }
  return { bot, Harness, send: onSend }
}

it.each([
  ["ask_all", "Perguntar a todos", "Oi! Em uma linha, o que você faz?", ""],
  [
    "summarize",
    "Pedir resumo do time",
    "Resuma os resultados confirmados do último turno, com a autoria de cada membro.",
    "Oi! Em uma linha, o que você faz?",
  ],
] as const)("resumes the %s group action exactly once after login", async (action, label, prompt, remainingDraft) => {
  vi.useFakeTimers()
  const f = fixture("waiting")
  const { bot, Harness, send } = recoveringComposer(f, vi.fn().mockResolvedValue(undefined), "Equipe")
  render(<Harness />)
  await act(async () => {})

  chooseTeamAction(label)
  await act(async () => {})
  expect(send).not.toHaveBeenCalled()
  f.setFlow({ provider: bot.provider, state: "ready" })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })

  expect(send).toHaveBeenCalledExactlyOnceWith(prompt, null, [], action)
  expect(screen.getByRole("textbox")).toHaveValue(remainingDraft)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(send).toHaveBeenCalledOnce()
})

it.each(["idle", "waiting", "cancelled", "error"] as const)(
  "%s: a VM draft remains editable and an attempted send resumes exactly once when login recovers",
  async (state) => {
    vi.useFakeTimers()
    const f = fixture(state)
    const { bot, Harness, send } = recoveringComposer(f)
    render(<Harness />)
    await act(async () => {})
    expect(screen.getAllByRole("complementary", { name: "Autenticação necessária" })).toHaveLength(1)
    const input = screen.getByRole("textbox")
    expect(input).toBeEnabled()
    expect(screen.getByRole("button", { name: "Enviar" })).toBeEnabled()
    fireEvent.keyDown(input, { key: "Enter" })
    await act(async () => {})
    expect(send).not.toHaveBeenCalled()
    expect(input).toHaveValue("Oi! Em uma linha, o que você faz?")
    expect(f.request.mock.calls.some(([, input]) => input.action === "start")).toBe(false)
    f.setFlow({ provider: bot.provider, state: "ready" })
    if (state !== "waiting") fireEvent.focus(window)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(send).toHaveBeenCalledExactlyOnceWith("Oi! Em uma linha, o que você faz?", null, [])
    expect(input).toHaveValue("")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(send).toHaveBeenCalledOnce()
  },
)

it("a failed check offers checking the saved login again without launching browser login", async () => {
  const f = fixture("ready")
  const request = f.api.request
  let available = false
  f.api.request = (async (route, input, path) => {
    if (!available && route === "GET /bots/:id/provider-login/flow") throw new Error("vault timeout")
    return request(route, input, path)
  }) as ApiRequest
  const { Harness, send } = recoveringComposer(f)
  render(<Harness />)
  await screen.findByText("Não foi possível verificar o login salvo. Verifique de novo.")
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
  await waitFor(() => expect(screen.getByRole("button", { name: "Verificar de novo" })).toBeEnabled())
  expect(send).not.toHaveBeenCalled()
  available = true
  fireEvent.click(screen.getByRole("button", { name: "Verificar de novo" }))
  await waitFor(() => expect(send).toHaveBeenCalledOnce())
  expect(f.request.mock.calls.some(([route]) => route === "POST /bots/:id/provider-login/flow")).toBe(false)
})

it.each(["edit", "conversation"] as const)(
  "does not send an old draft after a %s change while login recovers",
  async (change) => {
    vi.useFakeTimers()
    const f = fixture("cancelled")
    const { bot, Harness, send } = recoveringComposer(f)
    const view = render(<Harness />)
    await act(async () => {})
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    await act(async () => {})
    if (change === "edit") fireEvent.change(screen.getByRole("textbox"), { target: { value: "Outro rascunho" } })
    else view.rerender(<Harness threadId="second-thread" />)
    f.setFlow({ provider: bot.provider, state: "ready" })
    fireEvent.focus(window)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(send).not.toHaveBeenCalled()
    expect(screen.getByRole("textbox")).not.toHaveValue("")
    expect(screen.getByRole("button", { name: "Enviar" })).toBeEnabled()
  },
)

it("offers provider sign-in explicitly and cancellation leaves the draft usable", async () => {
  const f = fixture("idle")
  const { bot, Harness, send } = recoveringComposer(f)
  render(<Harness />)
  const provider = bot.provider === "claude" ? "Claude" : "Codex"
  fireEvent.click(await screen.findByRole("button", { name: `Entrar no ${provider}` }))
  fireEvent.click(await screen.findByRole("button", { name: "Cancelar login" }))
  await screen.findByText("Login cancelado.")
  expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeEnabled()
  expect(screen.getByRole("button", { name: "Verificar de novo" })).toBeEnabled()
  expect(screen.getByRole("button", { name: "Enviar" })).toBeEnabled()
  expect(screen.getByRole("textbox")).toHaveValue("Oi! Em uma linha, o que você faz?")
  expect(send).not.toHaveBeenCalled()
})

it.each(["failure", "cancelled"] as const)("ignores a stale poll's %s after a successful recheck", async (outcome) => {
  const f = fixture("ready")
  const request = f.api.request
  let reject: ((error: Error) => void) | undefined
  let resolve: ((flow: ProviderLoginFlow) => void) | undefined
  let first = true
  f.api.request = (async (route, input, path) => {
    if (first && route === "GET /bots/:id/provider-login/flow") {
      first = false
      return new Promise<ProviderLoginFlow>((yes, no) => {
        resolve = yes
        reject = no
      })
    }
    return request(route, input, path)
  }) as ApiRequest
  const { result } = renderHook(() => useProviderLogin(f.api, "bot", "codex", true, false))
  await act(async () => {
    await result.current.recheck()
  })
  expect(result.current.flow?.state).toBe("ready")
  await act(async () => {
    if (outcome === "failure") reject?.(new Error("old vault error"))
    else resolve?.({ provider: "codex", state: "cancelled" })
  })
  expect(result.current.flow?.state).toBe("ready")
  expect(result.current.error).toBeNull()
})

it.each([
  ["Login cancelado.", "Sign-in cancelled."],
  ["Não foi possível verificar o login salvo. Verifique de novo.", "Could not check the saved login. Check again."],
  ["Verificar de novo", "Check again"],
  ["Usar outra conta", "Use another account"],
  [
    "Sua mensagem fica como rascunho até o login estar pronto.",
    "Your message stays as a draft until sign-in is ready.",
  ],
] as const)("translates login recovery copy: %s", (key, english) => {
  expect(t(key, {}, "pt-BR")).toBe(key)
  expect(t(key, {}, "en")).toBe(english)
  expect(t("Entrar no {provider}", { provider: "Claude" }, "pt-BR")).toBe("Entrar no Claude")
  expect(t("Entrar no {provider}", { provider: "Claude" }, "en")).toBe("Sign in to Claude")
})

it.each([
  { hostKind: "computer", noun: "computador", hasLink: false },
  { hostKind: "computer", noun: "computador", hasLink: true },
  { hostKind: "server", noun: "servidor", hasLink: false },
  { hostKind: "server", noun: "servidor", hasLink: true },
] as const)(
  "waiting $hostKind login with link=$hasLink describes its reported host",
  async ({ hostKind, noun, hasLink }) => {
    const f = fixture("waiting")
    f.setFlow({
      provider: "codex",
      state: "waiting",
      host: "server",
      hostKind,
      ...(hasLink ? { verificationUrl: "https://example.test/login" } : {}),
    })

    render(<ProviderLogin api={f.api} botId="draft-test" provider="codex" onConfigured={vi.fn()} />)

    const message = hasLink
      ? `Entre no Codex para este ${noun}: abra este link neste aparelho`
      : `Preparando o login do Codex para este ${noun}…`
    expect(await screen.findByText(message)).toBeVisible()
    expect(screen.queryByRole("link", { name: "Abrir página de login" }) !== null).toBe(hasLink)
  },
)

it.each(["codex", "claude", "opencode"] as const)(
  "%s server login offers a device link and copyable code without opening a desktop",
  async (provider) => {
    const f = fixture("waiting")
    const open = vi.spyOn(window, "open").mockImplementation(() => null)
    const copy = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } })
    const url = "https://opencode.ai/auth?state=synthetic-state"
    f.setFlow({ provider, state: "waiting", host: "server", deviceCode: "1234-5678", verificationUrl: url })
    render(<ProviderLogin api={f.api} botId="draft-test" provider={provider} onConfigured={vi.fn()} />)
    await screen.findByText(/para este servidor: abra este link neste aparelho/)
    expect(screen.getByText(/O login expira em até 10 minutos/)).toBeVisible()
    expect(screen.getByRole("link", { name: "Abrir página de login" })).toHaveAttribute("href", url)
    expect(screen.getByRole("textbox", { name: "Código de login" })).toHaveValue("1234-5678")
    expect(open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Copiar código" }))
    await screen.findByText("Código copiado.")
    expect(copy).toHaveBeenCalledWith("1234-5678")
    copy.mockRejectedValueOnce(new Error("unavailable"))
    fireEvent.click(screen.getByRole("button", { name: "Copiar código" }))
    await screen.findByText("Não foi possível copiar. Selecione e copie o código acima.")
    fireEvent.click(screen.getByRole("button", { name: "Cancelar login" }))
    await screen.findByText("Login cancelado.")
    expect(screen.queryByRole("link")).toBeNull()
    expect(screen.queryByRole("textbox", { name: "Código de login" })).toBeNull()
    open.mockRestore()
  },
)

it("restarts a timed-out server login instead of offering only a status check", async () => {
  const f = fixture("error")
  f.setFlow({
    provider: "codex",
    state: "error",
    host: "server",
    retryable: true,
    message: "O login expirou. Tente novamente.",
  })
  render(<ProviderLogin api={f.api} botId="draft-test" provider="codex" onConfigured={vi.fn()} />)
  await screen.findByText("O login expirou. Tente novamente.")
  fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }))
  await screen.findByText("Aguardando login no navegador…")
  expect(f.request).toHaveBeenCalledWith(
    "POST /bots/:id/provider-login/flow",
    { provider: "codex", action: "start" },
    { id: "draft-test" },
  )
})

it("restarts a waiting server attempt by cancelling the old CLI first", async () => {
  const f = fixture("waiting")
  f.setFlow({ provider: "opencode", state: "waiting", host: "server" })
  render(<ProviderLogin api={f.api} botId="draft-test" provider="opencode" onConfigured={vi.fn()} />)
  fireEvent.click(await screen.findByRole("button", { name: "Tentar de novo" }))
  await waitFor(() =>
    expect(f.request.mock.calls.filter(([route]) => route.startsWith("POST")).map(([, input]) => input.action)).toEqual(
      ["cancel", "start"],
    ),
  )
})

it.each([
  [
    "Entre no {provedor} para o servidor: abra este link neste aparelho",
    "Sign in to {provedor} for the server: open this link on this device",
  ],
  ["O login expirou. Tente novamente.", "Sign-in expired. Try again."],
  ["Copiar código", "Copy code"],
  ["Código copiado.", "Code copied."],
  ["Não foi possível copiar. Selecione e copie o código acima.", "Could not copy. Select and copy the code above."],
] as const)("translates remote login copy: %s", (key, english) => {
  expect(t(key, {}, "pt-BR")).toBe(key)
  expect(t(key, {}, "en")).toBe(english)
})

it("blocks the OpenCode method that requires a server browser while allowing menu navigation", async () => {
  const f = fixture("waiting")
  f.setFlow({
    provider: "opencode",
    state: "waiting",
    host: "server",
    prompt: { kind: "method", choice: "Conta (browser)" },
  })
  render(<ProviderLogin api={f.api} botId="draft-test" provider="opencode" onConfigured={vi.fn()} />)
  await screen.findByText("Escolha um método com código para entrar por este aparelho.")
  expect(screen.getByRole("button", { name: "Confirmar opção" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Próxima opção" })).toBeEnabled()
})

it("does not restart a server CLI if the login view closes while cancellation is pending", async () => {
  const f = fixture("waiting")
  f.setFlow({ provider: "opencode", state: "waiting", host: "server" })
  const request = f.api.request
  let finish: (() => void) | undefined
  f.api.request = (async (route, input, path) => {
    if (route === "POST /bots/:id/provider-login/flow" && (input as { action?: string }).action === "cancel")
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    return request(route, input, path)
  }) as ApiRequest
  const view = render(<ProviderLogin api={f.api} botId="draft-test" provider="opencode" onConfigured={vi.fn()} />)
  fireEvent.click(await screen.findByRole("button", { name: "Tentar de novo" }))
  view.unmount()
  await act(async () => finish?.())
  expect(f.request.mock.calls.some(([, input]) => input.action === "start")).toBe(false)
})
