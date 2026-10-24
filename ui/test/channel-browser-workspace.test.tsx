import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import App from "../src/App"
import { getChannelBrowserWorkspaceFixture } from "./channel-browser-workspace-fixture"

vi.mock("../src/features/desktop/inlineFrameSource", () => ({
  startInlineFrameSource: vi.fn(() => () => {}),
}))

afterEach(cleanup)

test.each([
  { viewerId: "person-requester", controllerId: null, canControl: true, canStop: true },
  { viewerId: "owner", controllerId: null, canControl: true, canStop: true },
  { viewerId: "person-observer", controllerId: null, canControl: false, canStop: false },
  { viewerId: "owner", controllerId: "owner", canControl: true, canStop: false },
  { viewerId: "person-requester", controllerId: "owner", canControl: false, canStop: false },
])(
  "workspace activity presents controls for $viewerId with controller=$controllerId",
  async ({ viewerId, controllerId, canControl, canStop }) => {
    const fixture = await getChannelBrowserWorkspaceFixture({ viewerId, controllerId })
    render(<App kernel={{ services: { api: fixture.api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para Léo" })
    expect(screen.queryByRole("status", { name: /Léo no navegador · pedido de Ana/ })).toBeNull()

    fireEvent.click(await screen.findByRole("tab", { name: /^Work,/ }))
    fireEvent.click(await screen.findByRole("button", { name: /^Viagens/ }))

    const header = controllerId
      ? "Léo no navegador · pedido de Ana · Carla está no controle"
      : "Léo no navegador · pedido de Ana"
    expect(await screen.findByRole("status", { name: header })).toBeVisible()
    const card = await screen.findByRole("article", { name: "Navegador do Léo" })
    const composer = screen.getByRole("textbox", { name: "Mensagem para Viagens" })
    const status = composer.closest(".chat-panel")?.querySelector(".composer-browser-status")
    if (!(status instanceof HTMLElement)) throw new Error("Missing browser status")
    expect(within(card).getByText("Todos no canal veem")).toBeVisible()
    expect(within(card).queryByRole("button", { name: "Assumir", exact: true }) !== null).toBe(canControl)
    expect(within(status).queryByRole("button", { name: "Parar Léo" }) !== null).toBe(canStop)
    await waitFor(() =>
      expect(within(status).queryByRole("button", { name: "Assumir", exact: true }) !== null).toBe(canControl),
    )
    expect(composer).toBeEnabled()
  },
)

test("live browser activity updates requester and controller in the production header", async () => {
  const fixture = await getChannelBrowserWorkspaceFixture({ viewerId: "person-requester" })
  render(<App kernel={{ services: { api: fixture.api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para Léo" })
  fireEvent.click(await screen.findByRole("tab", { name: /^Work,/ }))
  fireEvent.click(await screen.findByRole("button", { name: /^Viagens/ }))
  const stop = await screen.findByRole("button", { name: "Parar Léo" })
  act(() => stop.focus())

  act(() =>
    fixture.emit({
      type: "browser.channel_run",
      run: Object.assign({}, fixture.browserRun, {
        controllerPersonId: "owner",
        controllerName: "Carla",
        status: "taken_over",
      }),
    }),
  )

  expect(
    await screen.findByRole("status", { name: "Léo no navegador · pedido de Ana · Carla está no controle" }),
  ).toBeVisible()
  expect(screen.queryByRole("button", { name: "Parar Léo" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Assumir", exact: true })).toBeNull()
  expect(screen.getByRole("textbox", { name: "Mensagem para Viagens" })).toHaveFocus()
})
