import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import type { TauriInvoke } from "../src/api/client"
import { ConnectionNotice } from "../src/features/server/ConnectionNotice"
import { t } from "../src/i18n"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test("a temporary outage only shows a quiet reconnection status", () => {
  const invoke = vi.fn<TauriInvoke>(async () => null)

  render(<ConnectionNotice invoke={invoke} />)

  expect(screen.getByRole("status")).toHaveTextContent("Reconectando…")
  expect(screen.queryByRole("button")).not.toBeInTheDocument()
  expect(invoke).not.toHaveBeenCalled()
  expect(t("Reconectando…", {}, "en")).toBe("Reconnecting…")
})

test("an incompatible protocol only installs an update after an explicit click", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {})
  const invoke = vi.fn<TauriInvoke>(async () => null)
  render(<ConnectionNotice incompatible invoke={invoke} />)
  expect(invoke).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole("button", { name: "Atualizar agora" }))

  await waitFor(() => expect(invoke).toHaveBeenCalledExactlyOnceWith("updater_install", {}))
})

test("a failed update keeps the conversation open and offers a retry", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {})
  const invoke = vi.fn<TauriInvoke>(async () => {
    throw new Error("Update failed")
  })
  render(<ConnectionNotice incompatible invoke={invoke} />)

  fireEvent.click(screen.getByRole("button", { name: "Atualizar agora" }))

  expect(await screen.findByText("Não foi possível atualizar. Tente novamente.")).toBeVisible()
  expect(screen.getByRole("button", { name: "Atualizar agora" })).toBeEnabled()
})

test("the quiet status distinguishes device offline, server retries and a connected idle bot", () => {
  const invoke = vi.fn<TauriInvoke>(async () => null)
  const retry = vi.fn()
  const view = render(
    <ConnectionNotice status={{ state: "offline", attempt: 2, retryAt: null }} onRetry={retry} invoke={invoke} />,
  )

  expect(screen.getByRole("status")).toHaveTextContent("Este aparelho está sem internet.")
  expect(screen.queryByRole("button")).not.toBeInTheDocument()
  view.rerender(
    <ConnectionNotice status={{ state: "unavailable", attempt: 3, retryAt: 1000 }} onRetry={retry} invoke={invoke} />,
  )

  expect(screen.getByRole("status")).toHaveTextContent("Tentativa 3 falhou. Nova tentativa automática agendada.")
  expect(screen.getByRole("status")).toHaveAttribute("data-connection-retry-at", "1000")
  fireEvent.click(screen.getByRole("button", { name: "Tentar agora" }))
  expect(retry).toHaveBeenCalledOnce()
  view.rerender(
    <ConnectionNotice status={{ state: "unavailable", attempt: 4, retryAt: null }} onRetry={retry} invoke={invoke} />,
  )

  expect(screen.getByRole("status")).toHaveTextContent("Tentativa 4 em andamento.")
  view.rerender(<ConnectionNotice status={{ state: "connected", attempt: 4, retryAt: null }} idle invoke={invoke} />)

  expect(screen.getByRole("status")).toHaveTextContent("Este bot não tem tarefa em execução. Envie uma mensagem")
  expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite")
  expect(screen.getByRole("status")).toHaveAttribute("data-connection-state", "idle")
})

test("web pairing opens separately and access is only checked after an explicit action", () => {
  const invoke = vi.fn<TauriInvoke>(async () => null)
  const retry = vi.fn()

  render(
    <ConnectionNotice
      status={{ state: "session-expired", attempt: 2, retryAt: null }}
      onRetry={retry}
      invoke={invoke}
    />,
  )

  expect(screen.getByRole("status")).toHaveTextContent("A sessão expirou ou o acesso foi revogado.")
  expect(screen.getByRole("status")).toHaveTextContent("Mensagens pendentes e histórico são mantidos.")
  expect(screen.getByRole("link", { name: "Parear novamente" })).toHaveAttribute("href", "/login")
  expect(screen.getByRole("link", { name: "Parear novamente" })).toHaveAttribute("target", "_blank")
  expect(screen.getByRole("link", { name: "Parear novamente" })).toHaveAttribute("rel", "noopener noreferrer")
  expect(retry).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole("button", { name: "Verificar acesso" }))

  expect(retry).toHaveBeenCalledOnce()
  expect(invoke).not.toHaveBeenCalled()
})

test("desktop pairing uses the existing settings action without automatically pairing", () => {
  const invoke = vi.fn<TauriInvoke>(async () => null)
  const pair = vi.fn()

  render(
    <ConnectionNotice status={{ state: "session-expired", attempt: 1, retryAt: null }} onPair={pair} invoke={invoke} />,
  )

  expect(pair).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Parear novamente" }))
  expect(pair).toHaveBeenCalledOnce()
  expect(invoke).not.toHaveBeenCalled()
})

test.each([
  [
    "Este aparelho está sem internet. Conecte-se à rede; a reconexão é automática.",
    "This device is offline. Connect to a network; reconnection is automatic.",
  ],
  [
    "A sessão expirou ou o acesso foi revogado. Pareie novamente e verifique o acesso aqui. Mensagens pendentes e histórico são mantidos.",
    "The session expired or access was revoked. Pair again, then check access here. Pending messages and history are kept.",
  ],
  [
    "Conectado. Este bot não tem tarefa em execução. Envie uma mensagem para começar.",
    "Connected. This bot has no task running. Send a message to get started.",
  ],
  [
    "Servidor indisponível. Tentativa {attempt} falhou. Nova tentativa automática agendada. Confira se o servidor está ligado.",
    "Server unavailable. Attempt 3 failed. An automatic retry is scheduled. Check that the server is on.",
  ],
  [
    "Conectando ao servidor. Tentativa {attempt} em andamento. Aguarde ou confira a rede e o servidor.",
    "Connecting to the server. Attempt 3 is in progress. Wait or check the network and server.",
  ],
  ["Parear novamente", "Pair again"],
  ["Verificar acesso", "Check access"],
  ["Tentar agora", "Try now"],
  ["Conectado ao servidor.", "Connected to the server."],
] as const)("connection copy is available in English: %s", (key, english) => {
  expect(t(key, { attempt: 3 }, "en")).toBe(english)
})
