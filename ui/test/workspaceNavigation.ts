import { fireEvent, screen } from "@testing-library/react"

export const openConversations = (name = "mark"): HTMLElement => {
  const conversations = screen.queryByRole("region", { name: `Conversas de ${name}` })
  if (conversations) return conversations

  fireEvent.click(screen.getByRole("button", { name: `Ações de ${name}` }))
  fireEvent.click(screen.getByRole("menuitem", { name: "Conversas", exact: true }))

  return screen.getByRole("region", { name: `Conversas de ${name}` })
}

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

/** Channel team actions ("Perguntar a todos", "Pedir resumo do time") live in one composer menu. */
export const chooseTeamAction = (action: string): void => {
  fireEvent.click(screen.getByRole("button", { name: "Ações do time" }))
  fireEvent.click(screen.getByRole("menuitem", { name: action }))
}
