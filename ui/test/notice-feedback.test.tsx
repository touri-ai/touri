import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { expect, test } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"

const notices = [
  { title: "Concluído", body: "Notas de demonstração salvas.", tone: "notice-info" },
  { title: "Conexão interrompida", body: "TOURI-E1009", tone: "notice-error" },
  { title: "Resposta interrompida", body: "TOURI-E1000", tone: "notice-error" },
]

test.each(notices)("$title uses the right feedback tone and remains dismissible", async ({ title, body, tone }) => {
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  act(() => api.emit({ type: "notify", title, body }))

  await waitFor(() => expect(screen.getByRole("status")).toHaveClass(tone))
  expect(screen.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
  if (tone === "notice-error") {
    expect(screen.getByRole("status").querySelector("p")).not.toHaveTextContent(/TOURI-E\d{4}/)
    expect(within(screen.getByRole("status")).getByRole("button", { name: /Detalhes/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    )
  }

  fireEvent.click(screen.getByRole("button", { name: "Dispensar aviso" }))

  await waitFor(() => expect(screen.queryByRole("status")).toBeNull())
  expect(screen.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
})
