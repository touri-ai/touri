import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"

afterEach(cleanup)

it("opens Work with one destination click and keeps People inside Work", async () => {
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.click(screen.getByRole("button", { name: "Avançado", exact: true }))
  const menu = screen.getByRole("navigation", { name: "Opções avançadas" })

  expect(within(menu).getAllByRole("button")).toHaveLength(5)
  expect(within(menu).queryByRole("button", { name: "Pessoas", exact: true })).toBeNull()
  fireEvent.click(within(menu).getByRole("button", { name: "Trabalho", exact: true }))

  expect(await screen.findByRole("heading", { name: "Trabalho", exact: true })).toBeVisible()
  expect(screen.queryByRole("navigation", { name: "Opções avançadas" })).toBeNull()
  const sections = screen.getByRole("navigation", { name: "Seções de Trabalho" })
  expect(within(sections).getByRole("button", { name: "Tarefas", exact: true })).toHaveAttribute("aria-pressed", "true")
  fireEvent.click(within(sections).getByRole("button", { name: "Pessoas", exact: true }))

  expect(within(sections).getByRole("button", { name: "Pessoas", exact: true })).toHaveAttribute("aria-pressed", "true")
  expect(screen.queryByRole("region", { name: "Trabalhando", exact: true })).toBeNull()
  expect(screen.queryByRole("dialog")).toBeNull()
  fireEvent.click(within(sections).getByRole("button", { name: "Tarefas", exact: true }))

  expect(screen.getByRole("region", { name: "Trabalhando", exact: true })).toBeVisible()
})
