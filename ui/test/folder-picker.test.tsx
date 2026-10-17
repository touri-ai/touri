import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { FolderListing } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import type { TauriInvoke } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { FolderPicker } from "../src/components/FolderPicker"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__")
})

const setup = () => {
  const api = createMockApi()
  const listing = (path = "/workspace"): FolderListing => ({
    home: "/workspace",
    path,
    parent: path === "/workspace" ? "/" : "/workspace",
    truncated: false,
    folders: path === "/workspace" ? [{ name: "Projects", path: "/workspace/Projects" }] : [],
  })
  const request = vi.fn(async (route, input) => {
    if (route === "GET /folders") return listing(input.path)
    if (route === "POST /folders") return { path: `${input.path}/${input.name}` }
    throw new Error("Unexpected request")
  })
  api.request = request as typeof api.request
  const select = vi.fn()
  const close = vi.fn()
  return { api, request, select, close, listing }
}
const useFolder = () => screen.getByRole("button", { name: "Usar esta pasta" })

it("starts at home, navigates folders and breadcrumbs, and confirms read-only access by default", async () => {
  const f = setup()
  render(<FolderPicker api={f.api} onSelect={f.select} onClose={f.close} />)
  expect(useFolder()).toBeDisabled()
  expect(await screen.findByRole("button", { name: "Projects" })).toBeEnabled()
  expect(f.request).toHaveBeenCalledWith("GET /folders", {})
  expect(screen.getByRole("radio", { name: "O bot pode ler", exact: true })).toBeChecked()
  fireEvent.click(screen.getByRole("button", { name: "Projects" }))
  expect(await screen.findByText("Nenhuma subpasta aqui.")).toBeVisible()
  expect(f.select).not.toHaveBeenCalled()
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "Caminho da pasta" })).getByRole("button", { name: "workspace" }),
  )
  await screen.findByRole("button", { name: "Projects" })
  fireEvent.click(useFolder())
  await waitFor(() => expect(f.select).toHaveBeenCalledWith({ path: "/workspace", access: "read-only" }))
})

it("preserves an explicit write choice while navigating and supports going up", async () => {
  const f = setup()
  render(<FolderPicker api={f.api} onSelect={f.select} onClose={f.close} />)
  await screen.findByRole("button", { name: "Projects" })
  fireEvent.click(screen.getByRole("radio", { name: "O bot pode ler e salvar arquivos aqui" }))
  fireEvent.click(screen.getByRole("button", { name: "Projects" }))
  await screen.findByText("Nenhuma subpasta aqui.")
  fireEvent.click(screen.getByRole("button", { name: "Voltar uma pasta" }))
  await screen.findByRole("button", { name: "Projects" })
  fireEvent.click(useFolder())
  await waitFor(() => expect(f.select).toHaveBeenCalledWith({ path: "/workspace", access: "read-write" }))
})

it("keeps typing secondary, validates the typed directory, and recovers from a rejected path", async () => {
  const f = setup()
  f.request.mockRejectedValueOnce(new Error("Esta pasta é protegida."))
  render(<FolderPicker api={f.api} onSelect={f.select} onClose={f.close} />)
  expect(await screen.findByRole("alert")).toHaveTextContent("Esta pasta é protegida.")
  expect(useFolder()).toBeDisabled()
  fireEvent.click(screen.getByText("Digitar caminho"))
  fireEvent.change(screen.getByLabelText("Caminho absoluto da pasta"), { target: { value: "/workspace/Projects" } })
  fireEvent.click(screen.getByRole("button", { name: "Abrir pasta" }))
  await screen.findByText("Nenhuma subpasta aqui.")
  expect(f.request).toHaveBeenLastCalledWith("GET /folders", { path: "/workspace/Projects" })
  fireEvent.click(useFolder())
  await waitFor(() => expect(f.select).toHaveBeenCalledWith({ path: "/workspace/Projects", access: "read-only" }))
})

it("creates a child only after confirmation, supports Escape, and enters the created directory", async () => {
  const f = setup()
  render(<FolderPicker api={f.api} onSelect={f.select} onClose={f.close} />)
  await screen.findByRole("button", { name: "Projects" })
  fireEvent.click(screen.getByRole("button", { name: "Nova pasta" }))
  fireEvent.change(screen.getByLabelText("Nome da nova pasta"), { target: { value: "Reports" } })
  fireEvent.keyDown(screen.getByLabelText("Nome da nova pasta"), { key: "Enter" })
  expect(f.request).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole("button", { name: "Continuar" }))
  expect(screen.getByRole("alertdialog", { name: "Criar pasta?" })).toHaveTextContent(
    "Criar a pasta Reports dentro de /workspace?",
  )
  fireEvent.keyDown(document, { key: "Escape" })
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  expect(f.close).not.toHaveBeenCalled()
  expect(f.request).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole("button", { name: "Continuar" }))
  fireEvent.click(screen.getByRole("button", { name: "Criar pasta", exact: true }))
  await waitFor(() => expect(f.request).toHaveBeenCalledWith("POST /folders", { path: "/workspace", name: "Reports" }))
  await screen.findByText("Nenhuma subpasta aqui.")
  expect(f.request).toHaveBeenLastCalledWith("GET /folders", { path: "/workspace/Reports" })
})

it("shows truncation, keeps errors actionable, and prevents duplicate creation while pending", async () => {
  const f = setup()
  f.request.mockResolvedValueOnce({ ...f.listing(), truncated: true })
  render(<FolderPicker api={f.api} onSelect={f.select} onClose={f.close} />)
  expect(await screen.findByText(/Há mais pastas/)).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Nova pasta" }))
  fireEvent.change(screen.getByLabelText("Nome da nova pasta"), { target: { value: "Reports" } })
  fireEvent.click(screen.getByRole("button", { name: "Continuar" }))
  f.request.mockRejectedValueOnce(new Error("Já existe uma pasta com esse nome."))
  fireEvent.click(screen.getByRole("button", { name: "Criar pasta", exact: true }))
  expect(await screen.findByRole("alert")).toHaveTextContent("Já existe uma pasta")
  let finish: ((result: { path: string }) => void) | undefined
  f.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const create = screen.getByRole("button", { name: "Criar pasta", exact: true })
  fireEvent.click(create)
  fireEvent.click(create)
  expect(f.request.mock.calls.filter(([route]) => route === "POST /folders")).toHaveLength(2)
  expect(useFolder()).toBeDisabled()
  await act(async () => finish?.({ path: "/workspace/Reports" }))
  await screen.findByText("Nenhuma subpasta aqui.")
})

it("offers the native desktop chooser while still requiring an explicit folder grant", async () => {
  const f = setup()
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true })
  const invoke = vi.fn(async () => ({ path: "/workspace/Projects" })) as ReturnType<typeof vi.fn> & TauriInvoke
  render(<FolderPicker api={f.api} invokeCommand={invoke} onSelect={f.select} onClose={f.close} />)
  await screen.findByRole("button", { name: "Projects" })
  fireEvent.click(screen.getByRole("button", { name: "Escolher no Mac…" }))
  await screen.findByText("Nenhuma subpasta aqui.")
  expect(invoke).toHaveBeenCalledWith("pick_folder", { title: "Escolher pasta" })
  expect(f.select).not.toHaveBeenCalled()
  expect(screen.getByRole("radio", { name: "O bot pode ler", exact: true })).toBeChecked()
  fireEvent.click(screen.getByRole("radio", { name: "O bot pode ler e salvar arquivos aqui" }))
  fireEvent.click(useFolder())
  await waitFor(() => expect(f.select).toHaveBeenCalledWith({ path: "/workspace/Projects", access: "read-write" }))
})

it("cancels and restores focus to the opener without granting access", async () => {
  const f = setup()
  const opener = document.createElement("button")
  document.body.append(opener)
  opener.focus()
  const view = render(<FolderPicker api={f.api} onSelect={f.select} onClose={f.close} />)
  await screen.findByRole("button", { name: "Projects" })
  fireEvent.keyDown(document, { key: "Escape" })
  expect(f.close).toHaveBeenCalledOnce()
  expect(f.select).not.toHaveBeenCalled()
  view.unmount()
  expect(opener).toHaveFocus()
  opener.remove()
})

it("does not grant the previous directory after a navigation failure and permits retrying a failed selection", async () => {
  const f = setup()
  f.select.mockRejectedValueOnce(new Error("Não foi possível salvar a pasta."))
  render(<FolderPicker api={f.api} onSelect={f.select} onClose={f.close} />)
  await screen.findByRole("button", { name: "Projects" })
  fireEvent.click(useFolder())
  expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível salvar a pasta.")
  expect(useFolder()).toBeEnabled()
  fireEvent.click(useFolder())
  await waitFor(() => expect(f.select).toHaveBeenCalledTimes(2))
  f.request.mockRejectedValueOnce(new Error("Esta pasta é protegida."))
  fireEvent.click(screen.getByRole("button", { name: "Projects" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("Esta pasta é protegida.")
  expect(useFolder()).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Pasta pessoal" }))
  await screen.findByRole("button", { name: "Projects" })
  expect(useFolder()).toBeEnabled()
})
