import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { DeleteRoutineDialog } from "../src/components/DeleteRoutineDialog"
import { t } from "../src/i18n"
import { openRoutines, showBotSettings } from "./workspaceNavigation"

const fixture = async () => {
  const api = createMockApi()
  const routine = (await api.request("GET /routines", {})).routines[0]
  if (!routine) throw new Error("Missing routine")
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  return { api, routine }
}
const deletes = (api: ReturnType<typeof createMockApi>) =>
  api.calls.filter((call) => call.route === "DELETE /routines/:id")

it("confirms card deletion, cancels without writing and removes the routine while preserving messages", async () => {
  const { api, routine } = await fixture()
  const messages = api.getState().messages.map((message) => message.id)
  openRoutines()
  const actions = await screen.findByRole("group", { name: `Ações da rotina ${routine.name}` })
  const trigger = within(actions).getByRole("button", { name: "Excluir rotina" })
  trigger.focus()
  fireEvent.click(trigger)
  const confirmation = screen.getByRole("alertdialog", { name: `Excluir a rotina ${routine.name}?` })
  expect(confirmation).toHaveAccessibleDescription(
    "Ela não vai mais rodar. O histórico de execuções continua nas conversas.",
  )
  expect(within(confirmation).getByRole("button", { name: "Cancelar" })).toHaveFocus()
  fireEvent.keyDown(document, { key: "Escape" })
  expect(screen.queryByRole("alertdialog")).toBeNull()
  expect(trigger).toHaveFocus()
  expect(deletes(api)).toHaveLength(0)
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole("button", { name: "Excluir", exact: true }))
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
  expect(deletes(api)).toEqual([{ route: "DELETE /routines/:id", input: {}, pathValues: { id: routine.id } }])
  expect((await api.request("GET /routines", {})).routines).toHaveLength(0)
  expect(screen.queryByRole("button", { name: `Editar ${routine.name}` })).toBeNull()
  expect(api.getState().messages.map((message) => message.id)).toEqual(messages)
})

it("deletes from the end of the editor and identifies the saved name even with unsaved edits", async () => {
  const { api, routine } = await fixture()
  openRoutines()
  fireEvent.click(await screen.findByRole("button", { name: `Editar ${routine.name}` }))
  const editor = screen.getByRole("dialog", { name: "Quando?" })
  expect(within(editor).getAllByRole("button").at(-1)).toHaveTextContent("Excluir rotina")
  fireEvent.change(within(editor).getByRole("textbox", { name: "Nome", exact: true }), {
    target: { value: "Rascunho não salvo" },
  })
  fireEvent.click(within(editor).getByRole("button", { name: "Excluir rotina" }))
  expect(screen.getByRole("alertdialog")).toHaveAccessibleName(`Excluir a rotina ${routine.name}?`)
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancelar" }))
  expect(within(editor).getByRole("textbox", { name: "Nome", exact: true })).toHaveValue("Rascunho não salvo")
  fireEvent.click(within(editor).getByRole("button", { name: "Excluir rotina" }))
  fireEvent.click(screen.getByRole("button", { name: "Excluir", exact: true }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  expect(deletes(api)).toHaveLength(1)
})

it("does not offer deletion for an unsaved draft", async () => {
  await fixture()
  openRoutines()
  fireEvent.click(await screen.findByRole("button", { name: "Criar rotina", exact: true }))
  expect(within(screen.getByRole("dialog")).queryByRole("button", { name: "Excluir rotina" })).toBeNull()
})

it("deletes from the routines list reached directly through Advanced → Routines", async () => {
  const { api, routine } = await fixture()
  showBotSettings()
  const settings = screen.getByRole("dialog")
  fireEvent.click(within(settings).getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.click(within(settings).getByRole("tab", { name: "Rotinas" }))
  await waitFor(() => expect(settings).not.toBeInTheDocument())
  fireEvent.click(
    within(await screen.findByRole("group", { name: `Ações da rotina ${routine.name}` })).getByRole("button", {
      name: "Excluir rotina",
    }),
  )
  fireEvent.click(screen.getByRole("button", { name: "Excluir", exact: true }))
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
  expect(screen.getByRole("region", { name: "Rotinas", exact: true })).toBeVisible()
  expect(screen.queryByText(routine.name)).toBeNull()
  expect(deletes(api)).toHaveLength(1)
})

it("traps keyboard focus and lets Escape cancel without deleting", async () => {
  const onDelete = vi.fn()
  const onClose = vi.fn()
  const user = userEvent.setup()
  render(<DeleteRoutineDialog routine={{ id: "r1", name: "Notas" }} onDelete={onDelete} onClose={onClose} />)
  await user.tab()
  expect(screen.getByRole("button", { name: "Excluir", exact: true })).toHaveFocus()
  await user.tab()
  expect(screen.getByRole("button", { name: "Fechar diálogo" })).toHaveFocus()
  await user.tab({ shift: true })
  expect(screen.getByRole("button", { name: "Excluir", exact: true })).toHaveFocus()
  await user.keyboard("{Escape}")
  expect(onClose).toHaveBeenCalledOnce()
  expect(onDelete).not.toHaveBeenCalled()
})

it("keeps failed deletion available to retry and sends one request while pending", async () => {
  let reject: (error: Error) => void = () => {}
  const onDelete = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        }),
    )
    .mockResolvedValueOnce(undefined)
  const onClose = vi.fn()
  render(<DeleteRoutineDialog routine={{ id: "r1", name: "Notas" }} onDelete={onDelete} onClose={onClose} />)
  fireEvent.click(screen.getByRole("button", { name: "Excluir", exact: true }))
  fireEvent.click(screen.getByRole("button", { name: "Excluindo…" }))
  fireEvent.keyDown(document, { key: "Escape" })
  expect(onClose).not.toHaveBeenCalled()
  expect(onDelete).toHaveBeenCalledOnce()
  reject(new Error("private transport detail"))
  expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível excluir a rotina. Tente novamente.")
  expect(screen.getByRole("alert")).not.toHaveTextContent("private transport detail")
  fireEvent.click(screen.getByRole("button", { name: "Excluir", exact: true }))
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  expect(onDelete).toHaveBeenCalledTimes(2)
})

it("provides Portuguese and English deletion copy", () => {
  expect(t("Excluir rotina", {}, "en")).toBe("Delete routine")
  expect(t("Excluir a rotina {name}?", { name: "Notes" }, "en")).toBe("Delete routine Notes?")
  expect(t("Ela não vai mais rodar. O histórico de execuções continua nas conversas.", {}, "en")).toBe(
    "It will no longer run. Execution history remains in conversations.",
  )
})
