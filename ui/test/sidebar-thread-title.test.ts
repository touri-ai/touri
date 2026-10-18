import { describe, expect, it } from "vitest"
import { getSidebarThreadTitle } from "../src/sidebarThreadTitle"

const getThread = (title: string) => ({ title, createdAt: new Date(2026, 9, 17).getTime() })

describe("sidebar thread titles", () => {
  it.each([
    "Monitor de caixa de entrada · 10/17/26, 7:04 PM",
    "Monitor de caixa de entrada · 10/17/2026, 7:04 PM",
    "Monitor de caixa de entrada · Oct 17, 7:04 PM",
    "Monitor de caixa de entrada • Oct 17, 2026, 7:04 PM",
    "Monitor de caixa de entrada · 17 de out., 19:04",
    "Monitor de caixa de entrada · 17 de out. de 2026, 19:04",
  ])("keeps the name without the generated timestamp: %s", (title) => {
    const thread = getThread(title)

    const displayedTitle = getSidebarThreadTitle(thread)

    expect(displayedTitle).toBe("Monitor de caixa de entrada")
    expect(thread.title).toBe(title)
  })

  it.each([
    "Plano do projeto",
    "Caixa de entrada · mensagens prioritárias",
    "Relatório · 10/17/26",
    "Relatório · 17 de out.",
    "Relatório · 19:04",
    "Relatório · 10/17/26, 7:04 PM · revisar",
  ])("preserves meaningful title text: %s", (title) => {
    const thread = getThread(title)

    const displayedTitle = getSidebarThreadTitle(thread)

    expect(displayedTitle).toBe(title)
  })

  it("preserves name segments and removes markdown decoration", () => {
    const thread = getThread("**Caixa de entrada** · prioritárias · 10/17/26, 7:04 PM")

    const displayedTitle = getSidebarThreadTitle(thread)

    expect(displayedTitle).toBe("Caixa de entrada · prioritárias")
  })

  it("retains a localized date when the title has no name", () => {
    const thread = getThread("Oct 17, 7:04 PM")

    const displayedTitle = getSidebarThreadTitle(thread)

    expect(displayedTitle).toMatch(/17.*out.*19:04/)
  })
})
