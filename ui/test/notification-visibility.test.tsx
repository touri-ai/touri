import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { Bot } from "@touri/contracts"
import { useState } from "react"
import { afterEach, expect, test, vi } from "vitest"
import type { UiApi } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { BotPanel } from "../src/components/BotPanel"
import {
  NotificationVisibilityProvider,
  useNotificationsOpen,
  useSetNotificationsOpen,
} from "../src/components/NotificationVisibility"
import { PreviewScreen } from "../src/components/WorkspaceScreens"

vi.mock("../src/components/BotComputer", () => ({
  BotComputer: ({ paused }: { paused: boolean }) => (
    <button type="button" disabled={paused}>
      Usar computador de teste
    </button>
  ),
}))

vi.mock("../src/components/PreviewPane", () => ({
  PreviewPane: ({ modalOpen }: { modalOpen: boolean }) => (
    <button type="button" disabled={modalOpen}>
      Usar preview de teste
    </button>
  ),
}))

afterEach(cleanup)

test("visibility changes do not rerender children that only set it", () => {
  const renderWriter = vi.fn()
  const Writer = () => {
    renderWriter(useSetNotificationsOpen())
    return <NotificationControls />
  }
  render(
    <NotificationVisibilityProvider>
      <Writer />
      <Visibility />
    </NotificationVisibilityProvider>,
  )
  const baseline = renderWriter.mock.calls.length
  expect(screen.getByRole("status")).toHaveTextContent("fechadas")

  fireEvent.click(screen.getByRole("button", { name: "Abrir notificações" }))

  expect(screen.getByRole("status")).toHaveTextContent("abertas")
  expect(renderWriter).toHaveBeenCalledTimes(baseline)

  fireEvent.click(screen.getByRole("button", { name: "Fechar notificações" }))

  expect(screen.getByRole("status")).toHaveTextContent("fechadas")
  expect(renderWriter).toHaveBeenCalledTimes(baseline)
})

test("standalone consumers default to closed notifications", () => {
  render(
    <>
      <NotificationControls />
      <Visibility />
    </>,
  )

  fireEvent.click(screen.getByRole("button", { name: "Abrir notificações" }))

  expect(screen.getByRole("status")).toHaveTextContent("fechadas")
})

test.each(["computer", "preview"] as const)(
  "%s pauses for notifications and keeps other dialog pauses after they close",
  async (surface) => {
    const api = createMockApi()
    render(
      <NotificationVisibilityProvider>
        <NotificationControls />
        <PauseHarness api={api} bot={getBot(api)} surface={surface} />
      </NotificationVisibilityProvider>,
    )
    const control = await screen.findByRole("button", {
      name: surface === "computer" ? "Usar computador de teste" : "Usar preview de teste",
    })
    expect(control).toBeEnabled()

    fireEvent.click(screen.getByRole("button", { name: "Abrir notificações" }))

    expect(control).toBeDisabled()

    fireEvent.click(screen.getByRole("button", { name: "Fechar notificações" }))

    expect(control).toBeEnabled()

    fireEvent.click(screen.getByRole("button", { name: "Abrir outro diálogo" }))

    expect(control).toBeDisabled()

    fireEvent.click(screen.getByRole("button", { name: "Abrir notificações" }))
    fireEvent.click(screen.getByRole("button", { name: "Fechar notificações" }))

    expect(control).toBeDisabled()

    fireEvent.click(screen.getByRole("button", { name: "Fechar outro diálogo" }))

    expect(control).toBeEnabled()

    fireEvent.click(screen.getByRole("button", { name: "Abrir notificações" }))
    fireEvent.click(screen.getByRole("button", { name: "Abrir outro diálogo" }))
    fireEvent.click(screen.getByRole("button", { name: "Fechar outro diálogo" }))

    expect(control).toBeDisabled()

    fireEvent.click(screen.getByRole("button", { name: "Fechar notificações" }))

    expect(control).toBeEnabled()
  },
)

test("the preview project menu stays paused when notifications close", () => {
  const api = createMockApi()
  render(
    <NotificationVisibilityProvider>
      <NotificationControls />
      <PauseHarness api={api} bot={getBot(api)} surface="preview" />
    </NotificationVisibilityProvider>,
  )
  const control = screen.getByRole("button", { name: "Usar preview de teste" })
  const menu = screen.getByRole("button", { name: "Menu do projeto" })

  fireEvent.click(menu)
  fireEvent.click(screen.getByRole("button", { name: "Abrir notificações" }))
  fireEvent.click(screen.getByRole("button", { name: "Fechar notificações" }))

  expect(control).toBeDisabled()

  fireEvent.click(menu)

  expect(control).toBeEnabled()
})

const NotificationControls = () => {
  const setOpen = useSetNotificationsOpen()

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Abrir notificações
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        Fechar notificações
      </button>
    </>
  )
}

const Visibility = () => {
  const open = useNotificationsOpen()

  return <span role="status">{open ? "abertas" : "fechadas"}</span>
}

const PauseHarness = ({ api, bot, surface }: { api: UiApi; bot: Bot; surface: "computer" | "preview" }) => {
  const [paused, setPaused] = useState(false)

  return (
    <>
      <button type="button" onClick={() => setPaused(true)}>
        Abrir outro diálogo
      </button>
      <button type="button" onClick={() => setPaused(false)}>
        Fechar outro diálogo
      </button>
      {surface === "computer" ? (
        <BotPanel
          api={api}
          bot={bot}
          routines={[]}
          paused={paused}
          expanded={false}
          computerTabRequest={1}
          onExpand={() => undefined}
          onWindow={async () => undefined}
          onClose={() => undefined}
          onSettings={() => undefined}
          onRoutines={() => undefined}
          onPermissions={() => undefined}
          onRole={async () => undefined}
        />
      ) : (
        <PreviewScreen
          api={api}
          project={null}
          processes={[]}
          preview={{
            projectId: "project-test",
            processId: null,
            url: "about:blank",
            port: 3000,
            label: "Preview de teste",
          }}
          modalOpen={paused}
          browserTabs={[]}
          selectedBot={bot}
          selectedThread={null}
          selectedMessages={[]}
          invokeCommand={vi.fn()}
          onStart={async () => undefined}
          onStop={async () => undefined}
          onRestart={async () => undefined}
          onSend={async () => undefined}
          onBack={() => undefined}
          onConnectProject={() => undefined}
          onNotice={() => undefined}
        />
      )}
    </>
  )
}

const getBot = (api: ReturnType<typeof createMockApi>): Bot => {
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Missing synthetic bot")

  return bot
}
