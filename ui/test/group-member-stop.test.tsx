import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import App from "../src/App"
import type { UiApi } from "../src/api/client"
import { createChannelWorkApi } from "./fixtures/channel-work-api"

it("stops a selected channel member with turn scope and starts its accepted follow-up", async () => {
  const api = createChannelWorkApi()
  const cancellation = vi.fn()
  const request: UiApi["request"] = async (route, input, path) => {
    if (route === "POST /runs/:id/cancel") cancellation(input, path)

    return api.request(route, input, path)
  }
  const client = Object.assign({}, api, { request })
  render(<App kernel={{ services: { api: client } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para Planejamento" })
  fireEvent.click(screen.getByRole("tab", { name: /^Work,/ }))
  const channels = await screen.findByRole("region", { name: "Canais" })
  fireEvent.click(within(channels).getByRole("button", { name: /^Equipe de demonstração/ }))
  await screen.findByRole("textbox", { name: "Mensagem para Equipe de demonstração" })

  fireEvent.click(screen.getByRole("button", { name: "Ações do time" }))
  fireEvent.click(screen.getByRole("menuitem", { name: "Parar Planejamento", exact: true }))

  await waitFor(() => expect(cancellation).toHaveBeenCalledWith({ scope: "turn" }, { id: "work-run-0" }))
  expect(cancellation).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.click(screen.getByRole("button", { name: "Trabalho", exact: true }))
  await waitFor(() => expect(document.querySelector('[data-run-id="channel-execution"]')).toBeVisible())
  expect(document.querySelector('[data-run-id="channel-waiting"]')).toBeNull()
  expect(document.querySelector('[data-run-id="work-run-0"]')).toBeNull()
})
