import { fireEvent, screen, within } from "@testing-library/react"

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
  const conversationActions: Record<string, string> = {
    "Nova conversa": "Nova conversa",
    "Selecionar conversas…": "Selecionar",
    Arquivadas: "Arquivadas",
    "Apagar conversas automáticas antigas…": "Apagar conversas automáticas antigas…",
  }
  const nested = conversationActions[action]
  if (nested) {
    const management = openConversations(name)
    fireEvent.click(within(management).getByRole("button", { name: new RegExp(`^${nested}`) }))
    return
  }
  fireEvent.click(screen.getByRole("button", { name: `Ações de ${name}` }))
  fireEvent.click(screen.getByRole("menuitem", { name: action }))
}

/** Channel team actions ("Perguntar a todos", "Pedir resumo do time") live in one composer menu. */
export const chooseTeamAction = (action: string): void => {
  fireEvent.click(screen.getByRole("button", { name: "Ações do time" }))
  fireEvent.click(screen.getByRole("menuitem", { name: action }))
}

export const openWork = (): void => {
  openGlobalPage("Trabalho")
}

export const chooseRoutineAction = async (name: string, action: string): Promise<HTMLElement> => {
  const trigger = await screen.findByRole("button", { name: `Ações da rotina ${name}`, exact: true })
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole("menuitem", { name: action, exact: true }))
  return trigger
}

export const openBotDetails = async (): Promise<HTMLElement> => {
  const toggle = await screen.findByRole("button", { name: "Painel do bot", exact: true })
  if (toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle)
  const adjust = await screen.findByRole("button", { name: "Ajustar", exact: true })
  if (adjust.getAttribute("aria-expanded") === "false") fireEvent.click(adjust)
  const panel = adjust.closest<HTMLElement>(".bot-panel")
  if (!panel) throw new Error("Missing bot details panel")
  return panel
}

export const openGlobalPage = (name: string): void => {
  if (!screen.queryByRole("navigation", { name: "Opções avançadas" }))
    fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  const menu = screen.getByRole("navigation", { name: "Opções avançadas" })
  const groupByPage: Record<string, string> = {
    MCP: "Ferramentas",
    Integrações: "Ferramentas",
    "Modelos por API": "Ferramentas",
    Trabalho: "Trabalho",
    Pessoas: "Trabalho",
    Desempenho: "Diagnóstico",
    "Reportar problema": "Diagnóstico",
  }
  const section = groupByPage[name] ?? (name.startsWith("Verificar") ? "Diagnóstico" : undefined)
  if (section) {
    const group = within(menu).getByRole("button", { name: section, exact: true })
    if (group.getAttribute("aria-expanded") === "false") fireEvent.click(group)
  }
  const destination = within(menu).getAllByRole("button", { name, exact: true }).at(-1)
  if (!destination) throw new Error(`Missing advanced destination: ${name}`)
  fireEvent.click(destination)
}
