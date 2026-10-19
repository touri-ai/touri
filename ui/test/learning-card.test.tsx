import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
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
    expect(screen.getByText(/usam a conta e as permissões atuais do bot/)).toBeVisible()
    fireEvent.click(memory)
    await waitFor(() => expect(memory).toBeChecked())
    expect(skills).not.toBeChecked()
    expect(screen.getByText("Ativo")).toBeVisible()
    expect(api.calls.filter((call) => call.route === "PUT /bots/:id/learning")).toEqual([
      { route: "PUT /bots/:id/learning", input: { memory: true }, pathValues: { id: "bot-mark" } },
    ])
    expect(t("Aprendizado contínuo", {}, "en")).toBe("Continuous learning")
  })

  it("isolates pending saves when switching bots", async () => {
    const api = createMockApi()
    let finish: (() => void) | undefined
    const request = api.request.bind(api)
    vi.spyOn(api, "request").mockImplementation(async (route, input, params) => {
      if (route === "PUT /bots/:id/learning")
        await new Promise<void>((resolve) => {
          finish = resolve
        })
      return request(route, input, params)
    })
    const { rerender } = render(<LearningCard api={api} botId="bot-mark" />)
    fireEvent.click(await screen.findByRole("switch", { name: /Memória automática/ }))
    rerender(<LearningCard api={api} botId="bot-other" />)
    await waitFor(() => expect(screen.getByRole("switch", { name: /Memória automática/ })).not.toBeChecked())
    await act(async () => {
      finish?.()
    })
    expect(screen.getByRole("switch", { name: /Memória automática/ })).not.toBeChecked()
    expect(screen.getByRole("switch", { name: /Memória automática/ })).toBeEnabled()
  })

  it("offers retry after an initial load failure", async () => {
    const api = createMockApi()
    vi.spyOn(api, "request").mockRejectedValueOnce(new Error("unavailable"))
    render(<LearningCard api={api} botId="bot-mark" />)
    expect(await screen.findByRole("alert")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: /Tentar novamente/ }))
    expect(await screen.findByRole("switch", { name: /Memória automática/ })).toBeEnabled()
  })

  it.each(["INVALID_PATH", "READ_ERROR"] as const)("keeps switches usable when entries report %s", async (reason) => {
    const api = createMockApi()
    await api.request("PUT /bots/:id/learning", { memory: true }, { id: "bot-mark" })
    const request = api.request.bind(api)
    vi.spyOn(api, "request").mockImplementation(async (route, input, params) => {
      const response = await request(route, input, params)
      if (route !== "GET /bots/:id/learning" && route !== "PUT /bots/:id/learning") return response
      if (!("learning" in response)) return response

      return { learning: { ...response.learning, memoryError: reason } }
    })
    render(<LearningCard api={api} botId="bot-mark" />)

    const memory = await screen.findByRole("switch", { name: /Memória automática/ })
    const warning = await screen.findByRole("alert")

    expect(warning).toHaveTextContent(/a memória sobre o ambiente \(MEMORY\.md\)/i)
    expect(warning).toHaveTextContent("Você ainda pode desligar o aprendizado.")
    expect(screen.getByText(/sobre o ambiente: — caracteres/)).toBeVisible()
    expect(screen.queryByText(/USER\.md:/)).toBeNull()
    expect(memory).toBeEnabled()
    expect(memory).toBeChecked()

    fireEvent.click(memory)

    await waitFor(() => expect(memory).not.toBeChecked())
    expect(warning).toBeVisible()
  })

  it("appears in Integrações only when a bot is selected", async () => {
    const api = createMockApi()
    const { rerender } = render(<IntegrationsScreen api={api} botId={null} botName={null} />)
    expect(screen.queryByText("Aprendizado contínuo")).toBeNull()
    rerender(<IntegrationsScreen api={api} botId="bot-mark" botName="mark" />)
    expect(await screen.findByText("Aprendizado contínuo")).toBeVisible()
  })
})
