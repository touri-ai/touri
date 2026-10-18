import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { Mem0Card } from "../src/components/Mem0Card"
import { t } from "../src/i18n"

const saves = (api: ReturnType<typeof createMockApi>) => api.calls.filter((call) => call.route === "PUT /bots/:id/mem0")

describe("Mem0 card", () => {
  it("starts off, saves the key write-only and never shows it again", async () => {
    const api = createMockApi()
    render(<Mem0Card api={api} botId="bot-mark" />)
    expect(await screen.findByText("Memória Mem0")).toBeVisible()
    expect(screen.getByText("Desligado")).toBeVisible()
    expect(screen.getByRole("switch", { name: "Ativar Mem0 para este bot" })).not.toBeChecked()
    expect(screen.getByText(/vai para o Mem0 Cloud/)).toBeVisible()
    fireEvent.click(screen.getByRole("switch", { name: "Ativar Mem0 para este bot" }))
    fireEvent.change(screen.getByLabelText("Chave da API"), { target: { value: "m0-ui-key" } })
    fireEvent.click(screen.getByRole("button", { name: "Salvar Mem0" }))
    expect(await screen.findByText("Salvo.")).toBeVisible()
    expect(saves(api)[0]).toMatchObject({
      pathValues: { id: "bot-mark" },
      input: { enabled: true, mode: "platform", scope: "user", apiKey: "m0-ui-key" },
    })
    expect(screen.getByText("Ligado")).toBeVisible()
    expect(screen.getByLabelText("Chave da API")).toHaveValue("")
    expect(screen.getByText(/Chave salva/)).toBeVisible()
    expect(document.body.textContent).not.toContain("m0-ui-key")
    fireEvent.click(screen.getByRole("button", { name: "Remover chave" }))
    await waitFor(() => expect(saves(api)[1]).toMatchObject({ input: { apiKey: null } }))
  })

  it("asks for a server URL in self-hosted mode, explains where data goes and tests the connection", async () => {
    const api = createMockApi()
    render(<Mem0Card api={api} botId="bot-mark" />)
    fireEvent.change(await screen.findByLabelText("Onde ficam as memórias"), { target: { value: "server" } })
    fireEvent.change(screen.getByLabelText("URL do servidor"), { target: { value: "http://localhost:8888" } })
    expect(screen.getByText(/vai para o seu servidor Mem0/)).toBeVisible()
    expect(screen.getByText(/não é usado em grupos, rotinas nem pedidos delegados/)).toBeVisible()
    fireEvent.change(screen.getByLabelText("Alcance"), { target: { value: "bot" } })
    fireEvent.click(screen.getByRole("button", { name: "Salvar Mem0" }))
    await waitFor(() =>
      expect(saves(api)[0]).toMatchObject({ input: { mode: "server", url: "http://localhost:8888", scope: "bot" } }),
    )
    expect(saves(api)[0]?.input).not.toHaveProperty("apiKey")
    fireEvent.click(screen.getByRole("button", { name: "Testar conexão" }))
    expect(await screen.findByText("Conexão funcionando.")).toBeVisible()
    expect(t("Memória Mem0", {}, "en")).toBe("Mem0 memory")
  })

  it("requires saving edited connection settings before testing", async () => {
    const api = createMockApi()
    render(<Mem0Card api={api} botId="bot-mark" />)
    const test = await screen.findByRole("button", { name: "Testar conexão" })
    expect(test).toBeEnabled()
    fireEvent.change(screen.getByLabelText("Chave da API"), { target: { value: "new-key" } })
    expect(test).toBeDisabled()
    expect(screen.getByText("Salve as alterações antes de testar a conexão.")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Salvar Mem0" }))
    await screen.findByText("Salvo.")
    expect(test).toBeEnabled()
    fireEvent.change(screen.getByLabelText("Onde ficam as memórias"), { target: { value: "server" } })
    expect(test).toBeDisabled()
  })

  it("ignores a save response from the previously selected bot", async () => {
    const api = createMockApi()
    const request = api.request.bind(api)
    let release = () => {}
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(api, "request").mockImplementation(async (route, input, path) => {
      if (route === "PUT /bots/:id/mem0") await pending
      return request(route, input, path)
    })
    const view = render(<Mem0Card api={api} botId="bot-mark" />)
    fireEvent.click(await screen.findByRole("switch", { name: "Ativar Mem0 para este bot" }))
    fireEvent.click(screen.getByRole("button", { name: "Salvar Mem0" }))
    view.rerender(<Mem0Card api={api} botId="bot-other" />)
    await waitFor(() =>
      expect(api.calls.some((call) => call.route === "GET /bots/:id/mem0" && call.pathValues?.id === "bot-other")).toBe(
        true,
      ),
    )
    await waitFor(() => expect(screen.getByRole("switch", { name: "Ativar Mem0 para este bot" })).not.toBeChecked())
    release()
    await waitFor(() => expect(saves(api)).toHaveLength(1))
    expect(screen.getByRole("switch", { name: "Ativar Mem0 para este bot" })).not.toBeChecked()
    expect(screen.getByText("Desligado")).toBeVisible()
  })

  it("translates connection errors in English", () => {
    expect(t("O Mem0 recusou a chave. Confira a chave e tente de novo.", {}, "en")).toBe(
      "Mem0 rejected the key. Check the key and try again.",
    )
    expect(t("O Mem0 não respondeu a tempo. Tente de novo.", {}, "en")).toBe("Mem0 did not respond in time. Try again.")
    expect(t("O servidor retornou uma resposta inválida. Confira a URL do Mem0.", {}, "en")).toBe(
      "The server returned an invalid response. Check the Mem0 URL.",
    )
  })

  it("explains that changing the destination requires a new key", async () => {
    const api = createMockApi()
    await api.request("PUT /bots/:id/mem0", { apiKey: "m0-original-destination" }, { id: "bot-mark" })
    render(<Mem0Card api={api} botId="bot-mark" />)
    fireEvent.change(await screen.findByLabelText("Onde ficam as memórias"), { target: { value: "server" } })
    fireEvent.change(screen.getByLabelText("URL do servidor"), { target: { value: "http://localhost:8888" } })
    const warning = "Ao mudar o destino, a chave anterior é removida. Digite a nova chave antes de salvar."
    expect(screen.getByText(warning)).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Salvar Mem0" }))
    await screen.findByText("Salvo.")
    expect(screen.queryByRole("button", { name: "Remover chave" })).not.toBeInTheDocument()
    expect(t(warning, {}, "en")).toBe(
      "Changing the destination removes the previous key. Enter the new key before saving.",
    )
  })
})
