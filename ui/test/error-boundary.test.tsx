import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { ErrorBoundary } from "../src/components/ErrorBoundary"
import { saveWorkspaceState } from "../src/workspaceState"
import { showBotSettings } from "./workspaceNavigation"

const crash = vi.hoisted(() => ({ chat: false, panel: false, modal: false, app: false }))
vi.mock("../src/components/ChatPanel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/ChatPanel")>()
  return {
    ...actual,
    ChatPanel: (props: Parameters<typeof actual.ChatPanel>[0]) => {
      if (crash.chat) throw new Error("Chat failed")
      return <actual.ChatPanel {...props} />
    },
  }
})
vi.mock("../src/components/BotPanel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/BotPanel")>()
  return {
    ...actual,
    BotPanel: (props: Parameters<typeof actual.BotPanel>[0]) => {
      if (crash.panel) throw new Error("Panel failed")
      return <actual.BotPanel {...props} />
    },
  }
})
vi.mock("../src/components/BotSidebar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/BotSidebar")>()
  return {
    ...actual,
    Sidebar: (props: Parameters<typeof actual.Sidebar>[0]) => {
      if (crash.app) throw new Error("App failed")
      return <actual.Sidebar {...props} />
    },
  }
})
vi.mock("../src/components/Modals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/Modals")>()
  return {
    ...actual,
    BotSettingsModal: (props: Parameters<typeof actual.BotSettingsModal>[0]) => {
      if (crash.modal) throw new Error("Modal failed")
      return <actual.BotSettingsModal {...props} />
    },
  }
})

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}))
afterEach(() => {
  cleanup()
  Object.assign(crash, { chat: false, panel: false, modal: false, app: false })
  vi.restoreAllMocks()
})

const ThrowingChild = ({ fail }: { fail: boolean }) => {
  if (fail) throw new Error("Render regression")
  return <p>Área recuperada</p>
}

test("throwing child shows a local fallback with collapsible details, logs and can recover", async () => {
  const api = createMockApi()
  const view = render(
    <ErrorBoundary area="a conversa" api={api}>
      <ThrowingChild fail />
    </ErrorBoundary>,
  )
  expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível mostrar a conversa")
  expect(screen.getByText("Detalhes do erro").closest(".ds-disclosure")).toHaveAttribute("data-open", "false")
  await waitFor(() => expect(api.calls.some((call) => call.route === "POST /ui/errors")).toBe(true))
  expect(api.calls.find((call) => call.route === "POST /ui/errors")?.input).toMatchObject({
    area: "a conversa",
    message: "Render regression",
    componentStack: expect.stringContaining("ThrowingChild"),
  })
  view.rerender(
    <ErrorBoundary area="a conversa" api={api}>
      <ThrowingChild fail={false} />
    </ErrorBoundary>,
  )
  fireEvent.click(screen.getByRole("button", { name: "Recarregar esta área" }))
  expect(screen.getByText("Área recuperada")).toBeVisible()
})

test("fallback stays usable when reporting to the sidecar fails", async () => {
  const api = createMockApi()
  vi.spyOn(api, "request").mockRejectedValue(new Error("Offline"))
  render(
    <ErrorBoundary area="o app" app api={api}>
      <ThrowingChild fail />
    </ErrorBoundary>,
  )
  expect(screen.getByRole("button", { name: "Recarregar app" })).toBeVisible()
  await waitFor(() => expect(api.request).toHaveBeenCalled())
  expect(screen.getByRole("alert")).toHaveTextContent("O app encontrou um erro")
})

for (const area of ["chat", "panel", "modal", "app"] as const) {
  test(`App isolates a render crash in ${area}`, async () => {
    const api = createMockApi()
    if (area === "chat") saveWorkspaceState({ panelsByBot: { "bot-mark": true } })
    if (area !== "modal") crash[area] = true
    render(<App kernel={{ services: { api } }} />)
    if (area === "panel") {
      await screen.findByRole("textbox", { name: "Mensagem para mark" })
      fireEvent.click(screen.getByRole("button", { name: "Painel do bot" }))
    }
    if (area === "modal") {
      await screen.findByRole("textbox", { name: "Mensagem para mark" })
      crash.modal = true
      showBotSettings()
    }
    const label = area === "app" ? "Recarregar app" : "Recarregar esta área"
    expect(await screen.findByRole("button", { name: label })).toBeVisible()
    if (area === "chat") expect(await screen.findByRole("complementary", { name: "Painel de mark" })).toBeVisible()
    if (area === "panel" || area === "modal")
      expect(screen.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    if (area === "modal") {
      expect(screen.getByRole("dialog", { name: "Erro no diálogo" })).toBeVisible()
      fireEvent.click(screen.getByRole("button", { name: "Fechar" }))
      expect(screen.queryByRole("dialog")).toBeNull()
    }
    await waitFor(() => expect(api.calls.some((call) => call.route === "POST /ui/errors")).toBe(true))
  })
}
