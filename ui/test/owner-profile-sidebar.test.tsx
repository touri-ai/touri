import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ApiRoutes } from "@touri/contracts"
import { expect, it } from "vitest"
import App from "../src/App"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"

const getProfileChip = (): HTMLButtonElement => {
  const chip = document.querySelector<HTMLButtonElement>(".user-chip")
  if (!chip) throw new Error("Missing profile shortcut")

  return chip
}

it("opens the profile editor directly from the sidebar without saving a draft", async () => {
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  fireEvent.click(getProfileChip())

  expect(await screen.findByRole("textbox", { name: "Nome do perfil" })).toBeVisible()
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Nome do perfil" })).toHaveFocus())
  expect(screen.getByRole("button", { name: /^Perfil/ })).toHaveAttribute("aria-expanded", "true")
  expect(screen.getAllByRole("tab").filter((tab) => tab.closest("[role=dialog]"))).toHaveLength(5)
  expect(api.calls.filter((call) => call.route === "PATCH /settings")).toHaveLength(0)
})

it("keeps the sidebar initials in sync with the saved profile name", async () => {
  const api = createMockApi()
  await api.request("PATCH /settings", { ownerProfile: { name: "Pessoa Teste", avatar: null } })
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  expect(getProfileChip()).toHaveTextContent("Pessoa Teste")
  expect(getProfileChip().querySelector(".person-initials")).toHaveTextContent("PT")
  fireEvent.click(getProfileChip())
  fireEvent.change(await screen.findByRole("textbox", { name: "Nome do perfil" }), {
    target: { value: "Pessoa Nova" },
  })

  expect(getProfileChip()).toHaveTextContent("Pessoa Teste")
  fireEvent.click(screen.getByRole("button", { name: "Salvar preferências" }))

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  expect(getProfileChip()).toHaveTextContent("Pessoa Nova")
  expect(getProfileChip().querySelector(".person-initials")).toHaveTextContent("PN")
})

it("shows the saved photo and restores profile initials when it is removed", async () => {
  const api = createMockApi()
  const dataUrl = "data:image/png;base64,iVBORw0KGgo="
  await api.request("PATCH /settings", {
    ownerProfile: { name: "Pessoa Teste", avatar: { kind: "image", dataUrl } },
  })
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  expect(getProfileChip().querySelector("img")).toHaveAttribute("src", dataUrl)
  fireEvent.click(getProfileChip())
  fireEvent.click(await screen.findByRole("button", { name: "Remover avatar do perfil" }))
  fireEvent.click(screen.getByRole("button", { name: "Salvar preferências" }))

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  expect(getProfileChip().querySelector("img")).toBeNull()
  expect(getProfileChip().querySelector(".person-initials")).toHaveTextContent("PT")
})

it("keeps another person's identity separate from the owner profile", async () => {
  const base = createMockApi()
  await base.request("PATCH /settings", { ownerProfile: { name: "Perfil Proprietário", avatar: null } })
  const request: ApiRequest = async (route, input, path, transport) => {
    if (route === "GET /session")
      return {
        ok: true,
        kind: "device",
        person: { id: "person-example", name: "Pessoa Convidada", email: null, avatarSeed: "guest", role: "member" },
      } as ApiRoutes[typeof route]["res"]

    return base.request(route, input, path, transport)
  }
  const api = { ...base, isMock: false, request }
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  fireEvent.click(getProfileChip())

  expect(await screen.findByRole("dialog")).toBeVisible()
  expect(screen.queryByRole("button", { name: /^Perfil/ })).toBeNull()
  expect(getProfileChip()).not.toHaveTextContent("Perfil Proprietário")
  expect(getProfileChip().querySelector(".person-initials")).toBeNull()
})

it("preserves the account mascot when the profile has not been customized", async () => {
  const api = createMockApi()
  await api.request("PATCH /settings", { ownerProfile: { name: "", avatar: null } })
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  expect(getProfileChip().querySelector(".tb-avatar")).toBeTruthy()
  expect(getProfileChip().querySelector(".person-initials")).toBeNull()
})
