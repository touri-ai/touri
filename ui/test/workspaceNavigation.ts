import { fireEvent, screen } from "@testing-library/react"

export const openRoutines = (name = "mark"): void => {
  fireEvent.click(screen.getByRole("button", { name: `Ações de ${name}` }))
  fireEvent.click(screen.getByRole("menuitem", { name: "Rotinas" }))
}

export const showBotSettings = (name = "mark"): void => {
  fireEvent.click(screen.getByRole("button", { name: `Ações de ${name}` }))
  fireEvent.click(screen.getByRole("menuitem", { name: "Avançado" }))
}

export const chooseBotAction = (action: string, name = "mark"): void => {
  fireEvent.click(screen.getByRole("button", { name: `Ações de ${name}` }))
  fireEvent.click(screen.getByRole("menuitem", { name: action }))
}

/** A bot row only opens its latest conversation; its other conversations sit behind the chevron. */
export const openConversations = (name = "mark"): HTMLElement => {
  const region = screen.queryByRole("region", { name: `Conversas de ${name}` })
  if (region) return region

  fireEvent.click(screen.getByRole("button", { name: `Conversas de ${name}` }))
  return screen.getByRole("region", { name: `Conversas de ${name}` })
}

/** Channel team actions ("Perguntar a todos", "Pedir resumo do time") live in one composer menu. */
export const chooseTeamAction = (action: string): void => {
  fireEvent.click(screen.getByRole("button", { name: "Ações do time" }))
  fireEvent.click(screen.getByRole("menuitem", { name: action }))
}
