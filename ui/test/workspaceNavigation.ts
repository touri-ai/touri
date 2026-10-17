import { fireEvent, screen } from "@testing-library/react"

export const openRoutines = (name = "mark"): void => {
  fireEvent.click(screen.getByRole("button", { name: `Ações de ${name}` }))
  fireEvent.click(screen.getByRole("menuitem", { name: "Rotinas" }))
}

export const showBotSettings = (name = "mark"): void => {
  fireEvent.click(screen.getByRole("button", { name: `Ações de ${name}` }))
  fireEvent.click(screen.getByRole("menuitem", { name: "Avançado" }))
}
