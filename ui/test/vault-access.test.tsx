import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { DoctorReport } from "@touri/contracts"
import { createRef, useState } from "react"
import { afterEach, expect, it, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { Composer } from "../src/components/Composer"
import { VaultAccessButton } from "../src/components/VaultAccessButton"
import { DoctorChecks } from "../src/features/doctor/DoctorChecks"
import { t } from "../src/i18n"

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke }))
afterEach(() => {
  vi.useRealTimers()
  invoke.mockReset()
})

it("authorizes in the native app and resumes the preserved attempted draft exactly once", async () => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("fixture bot missing")
  const request = api.request
  let authorized = false
  api.request = (async (route, input, path) =>
    route === "GET /bots/:id/provider-login/flow"
      ? { provider: bot.provider, state: authorized ? "ready" : "vault-locked" }
      : request(route, input, path)) as ApiRequest
  let finish: (() => void) | undefined
  invoke.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          authorized = true
          resolve()
        }
      }),
  )
  const send = vi.fn().mockResolvedValue(undefined)
  const Harness = () => {
    const [draft, setDraft] = useState("Oi! Em uma linha, o que você faz?")
    return (
      <Composer
        api={api}
        bot={{ ...bot, machine: "vm" }}
        threadId="thread"
        parentId={null}
        draft={draft}
        onDraft={setDraft}
        inputRef={createRef()}
        activeRun={null}
        queuedCount={0}
        onSend={send}
        onCancel={vi.fn()}
      />
    )
  }
  render(<Harness />)
  const allow = await screen.findByRole("button", { name: "Permitir acesso ao cofre" })
  expect(screen.queryByRole("button", { name: "Verificar de novo" })).toBeNull()
  expect(document.body.textContent).not.toMatch(/setup-token|Terminal/)
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
  await act(async () => {})
  expect(send).not.toHaveBeenCalled()
  fireEvent.click(allow)
  expect(await screen.findByRole("button", { name: "Aguardando permissão do macOS…" })).toBeDisabled()
  expect(invoke).toHaveBeenCalledExactlyOnceWith("vault_authorize", {
    account: `bot/${bot.id}/${bot.provider}-vm-login`,
  })
  expect(screen.getByRole("textbox")).toHaveValue("Oi! Em uma linha, o que você faz?")
  await act(async () => finish?.())
  await waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith("Oi! Em uma linha, o que você faz?", null, []))
  expect(screen.getByRole("textbox")).toHaveValue("")
})

it.each(["VAULT_CANCELLED", "VAULT_TIMEOUT"])(
  "%s keeps recovery retryable without exposing native errors",
  async (code) => {
    invoke.mockRejectedValue(code)
    const recheck = vi.fn()
    render(<VaultAccessButton account="bot/test/login" onAuthorized={recheck} />)
    fireEvent.click(screen.getByRole("button", { name: "Permitir acesso ao cofre" }))
    await screen.findByRole("alert")
    expect(screen.getByRole("button", { name: "Permitir acesso ao cofre" })).toBeEnabled()
    expect(document.body.textContent).not.toContain(code)
    expect(recheck).not.toHaveBeenCalled()
  },
)

it("ignores a completed authorization after switching to a different bot", async () => {
  let finish: (() => void) | undefined
  invoke.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const oldRecheck = vi.fn()
  const newRecheck = vi.fn()
  const view = render(<VaultAccessButton account="bot/old/login" onAuthorized={oldRecheck} />)
  fireEvent.click(screen.getByRole("button", { name: "Permitir acesso ao cofre" }))
  view.rerender(<VaultAccessButton account="bot/new/login" onAuthorized={newRecheck} />)
  await act(async () => finish?.())
  expect(oldRecheck).not.toHaveBeenCalled()
  expect(newRecheck).not.toHaveBeenCalled()
})

it("Doctor offers one foreground action and hides terminal recovery under other options", async () => {
  invoke.mockResolvedValue(undefined)
  const refresh = vi.fn().mockResolvedValue(undefined)
  const doctor: DoctorReport = {
    running: false,
    checks: [
      {
        id: "provider-login:test",
        label: "Login · Bot de teste · cofre",
        ok: false,
        status: "fail",
        detail: "Permita o acesso ao cofre para usar o login salvo.",
        action: "authorize-vault",
        vaultAccount: "bot/test/claude-vm-login",
        fix: "claude setup-token",
      },
    ],
  }
  render(<DoctorChecks doctor={doctor} error={null} onRefresh={refresh} />)
  const options = screen.getByText("Outras opções").closest("details")
  expect(options).not.toHaveAttribute("open")
  expect(screen.getByText("claude setup-token")).not.toBeVisible()
  expect(screen.queryByRole("button", { name: /^Copiar comando/ })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Permitir acesso ao cofre" }))
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
  expect(invoke).toHaveBeenCalledExactlyOnceWith("vault_authorize", { account: "bot/test/claude-vm-login" })
})

const serverGuidance =
  "O cofre local do servidor está indisponível. Verifique as permissões da pasta de dados do servidor e reinicie o serviço do touri. O login salvo será mantido."

it("server chat and Doctor show server guidance, preserve the draft and never invoke native authorization", async () => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("fixture bot missing")
  const request = api.request
  api.request = (async (route, input, path) =>
    route === "GET /bots/:id/provider-login/flow"
      ? { provider: bot.provider, state: "error", host: "server", message: serverGuidance }
      : request(route, input, path)) as ApiRequest
  const send = vi.fn()
  render(
    <>
      <Composer
        api={api}
        bot={{ ...bot, machine: "vm" }}
        threadId="thread"
        parentId={null}
        draft="Mensagem preservada"
        onDraft={vi.fn()}
        inputRef={createRef()}
        activeRun={null}
        queuedCount={0}
        onSend={send}
        onCancel={vi.fn()}
      />
      <DoctorChecks
        doctor={{
          running: false,
          checks: [
            {
              id: "provider-login:test",
              label: "Login · Bot de teste · cofre",
              ok: false,
              status: "fail",
              detail: serverGuidance,
              fix: null,
            },
          ],
        }}
        error={null}
        onRefresh={vi.fn()}
      />
    </>,
  )
  await waitFor(() => expect(screen.getAllByText(serverGuidance)).toHaveLength(2))
  expect(screen.queryByRole("button", { name: "Permitir acesso ao cofre" })).toBeNull()
  expect(document.body.textContent).not.toMatch(/macOS|Permitir sempre|setup-token/)
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
  fireEvent.click(screen.getByRole("button", { name: "Verificar de novo" }))
  await act(async () => {})
  expect(screen.getByRole("textbox")).toHaveValue("Mensagem preservada")
  expect(send).not.toHaveBeenCalled()
  expect(invoke).not.toHaveBeenCalled()
})

it("Doctor authorizes the browser session key and refreshes without replacing its saved session", async () => {
  invoke.mockResolvedValue(undefined)
  const refresh = vi.fn().mockResolvedValue(undefined)
  render(
    <DoctorChecks
      doctor={{
        running: false,
        checks: [
          {
            id: "browser-session:test",
            label: "Navegador · Bot de teste · sessão salva",
            ok: false,
            status: "fail",
            detail: "Permita o acesso ao cofre para restaurar a sessão salva do navegador.",
            action: "authorize-vault",
            vaultAccount: "browser-session-key:test",
            fix: null,
          },
        ],
      }}
      error={null}
      onRefresh={refresh}
    />,
  )
  expect(screen.getByText("Permita o acesso ao cofre para restaurar a sessão salva do navegador.")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Permitir acesso ao cofre" }))
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
  expect(invoke).toHaveBeenCalledExactlyOnceWith("vault_authorize", { account: "browser-session-key:test" })
})

it.each([
  ["Permitir acesso ao cofre", "Allow vault access"],
  ["Aguardando permissão do macOS…", "Waiting for macOS permission…"],
  ["Permita o acesso ao cofre para usar o login salvo.", "Allow vault access to use the saved sign-in."],
  ["Outras opções", "Other options"],
  [
    "Permita o acesso ao cofre para restaurar a sessão salva do navegador.",
    "Allow vault access to restore the saved browser session.",
  ],
  [
    serverGuidance,
    "The server’s local vault is unavailable. Check the permissions of the server’s data folder and restart the touri service. The saved sign-in will be kept.",
  ],
] as const)("localizes vault recovery: %s", (key, english) => {
  expect(t(key, {}, "pt-BR")).toBe(key)
  expect(t(key, {}, "en")).toBe(english)
})
