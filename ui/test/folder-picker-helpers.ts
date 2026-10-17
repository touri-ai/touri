import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { expect } from "vitest"

export const selectFolder = async (path: string, access?: "read-only" | "read-write") => {
  const picker = await screen.findByRole("dialog", { name: "Pastas no servidor" })
  const useFolder = within(picker).getByRole("button", { name: "Usar esta pasta" })
  await waitFor(() => expect(useFolder).toBeEnabled())
  fireEvent.click(within(picker).getByText("Digitar caminho"))
  fireEvent.change(within(picker).getByLabelText("Caminho absoluto da pasta"), { target: { value: path } })
  fireEvent.click(within(picker).getByRole("button", { name: "Abrir pasta" }))
  await waitFor(() => expect(useFolder).toBeEnabled())
  if (access)
    fireEvent.click(
      within(picker).getByRole("radio", {
        name: access === "read-only" ? "Somente leitura" : "O bot pode ler e salvar arquivos aqui",
        exact: true,
      }),
    )
  fireEvent.click(useFolder)
  await waitFor(() => expect(picker).not.toBeInTheDocument())
}
