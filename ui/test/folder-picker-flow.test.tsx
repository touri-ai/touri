import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { createWebInvoke } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { BotCreateModal, ProjectModal } from "../src/components/Modals"
import type { WorkspaceActions } from "../src/useWorkspace"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it("offers folders and projects in Advanced and saves the chosen folder access in the web UI", async () => {
  const api = createMockApi()
  const create = vi.fn()
  const prompt = vi.spyOn(window, "prompt")
  render(<BotCreateModal api={api} invokeCommand={createWebInvoke()} onCreate={create} onClose={vi.fn()} />)
  const advanced = screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ })

  expect(advanced).toHaveAttribute("aria-expanded", "false")
  expect(screen.queryByLabelText("Projeto", { selector: "select" })).toBeNull()

  fireEvent.click(advanced)

  expect(screen.getByLabelText("Projeto", { selector: "select" })).toBeVisible()

  fireEvent.click(screen.getByRole("button", { name: "Adicionar pasta…" }))

  const picker = screen.getByRole("dialog", { name: "Pastas no servidor" })
  await waitFor(() => expect(within(picker).getByRole("button", { name: "Usar esta pasta" })).toBeEnabled())
  expect(within(picker).getByRole("radio", { name: "Somente leitura", exact: true })).toBeChecked()
  fireEvent.click(within(picker).getByRole("button", { name: "Usar esta pasta" }))
  expect(await screen.findByLabelText("Acesso à pasta /workspace")).toHaveValue("read-only")
  expect(prompt).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Research" } })
  await screen.findByText(/Usa o Codex/)
  fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ folders: [{ path: "/workspace", access: "read-only" }] }),
      expect.any(String),
    ),
  )
})

it("uses the folder browser for Choose another folder in project connection", async () => {
  const api = createMockApi()
  const prompt = vi.spyOn(window, "prompt")
  render(
    <ProjectModal
      project={null}
      selectedBotId={api.getState().bots[0]?.id ?? null}
      bots={api.getState().bots}
      api={api}
      invokeCommand={createWebInvoke()}
      actions={
        {
          createProject: async (input) => (await api.request("POST /projects", input)).project,
          updateBot: async (id, input) => {
            await api.request("PATCH /bots/:id", input, { id })
          },
        } as WorkspaceActions
      }
      onClose={vi.fn()}
      onOpenPreview={vi.fn()}
      onNotice={vi.fn()}
    />,
  )
  fireEvent.click(await screen.findByRole("button", { name: "Escolher outra pasta…" }))
  const picker = screen.getByRole("dialog", { name: "Pastas no servidor" })
  await waitFor(() => expect(within(picker).getByRole("button", { name: "Usar esta pasta" })).toBeEnabled())
  expect(within(picker).getByRole("radio", { name: "Somente leitura", exact: true })).toBeChecked()
  fireEvent.click(within(picker).getByRole("button", { name: "Usar esta pasta" }))
  await waitFor(() => expect(screen.getByLabelText("Pasta do projeto")).toHaveValue("/workspace"))
  expect(prompt).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Conectar projeto", exact: true }))
  await waitFor(() => expect(api.getState().bots[0]?.folders).toEqual([{ path: "/workspace", access: "read-only" }]))
})
