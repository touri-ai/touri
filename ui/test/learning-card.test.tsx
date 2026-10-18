import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { createMockApi } from "../src/api/mock"
import { LearningCard } from "../src/components/LearningCard"
import { IntegrationsScreen } from "../src/components/WorkspaceScreens"
import { t } from "../src/i18n"

describe("continuous learning card", () => {
  it("starts off and saves each switch for the selected bot", async () => {
    const api = createMockApi()
    render(<LearningCard api={api} botId="bot-mark" />)
    const memory = await screen.findByRole("switch", { name: /Memória automática/ })
    const skills = screen.getByRole("switch", { name: /Skills automáticas/ })
    expect(memory).not.toBeChecked()
    expect(skills).not.toBeChecked()
    expect(screen.getByText("Desligado")).toBeVisible()
    expect(screen.getByText(/usam a conta do provedor do bot/)).toBeVisible()
    fireEvent.click(memory)
    await waitFor(() => expect(memory).toBeChecked())
    expect(skills).not.toBeChecked()
    expect(screen.getByText("Ativo")).toBeVisible()
    expect(api.calls.filter((call) => call.route === "PUT /bots/:id/learning")).toEqual([
      { route: "PUT /bots/:id/learning", input: { memory: true }, pathValues: { id: "bot-mark" } },
    ])
    expect(t("Aprendizado contínuo", {}, "en")).toBe("Continuous learning")
  })

  it("appears in Integrações only when a bot is selected", async () => {
    const api = createMockApi()
    const { rerender } = render(<IntegrationsScreen api={api} botId={null} botName={null} />)
    expect(screen.queryByText("Aprendizado contínuo")).toBeNull()
    rerender(<IntegrationsScreen api={api} botId="bot-mark" botName="mark" />)
    expect(await screen.findByText("Aprendizado contínuo")).toBeVisible()
  })
})
