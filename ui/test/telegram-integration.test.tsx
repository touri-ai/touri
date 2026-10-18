import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { TelegramIntegration } from "@touri/contracts"
import { describe, expect, it, vi } from "vitest"
import type { UiApi } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { TelegramIntegrationCard } from "../src/components/TelegramIntegrationCard"
import { t } from "../src/i18n"

const TOKEN = "123456789:AAExampleTokenForTouriTests_123456"

describe("Telegram integration card", () => {
  it("requires a saved token before enabling and explains the next step beside the token field", async () => {
    const api = createMockApi()
    const user = userEvent.setup()
    render(<TelegramIntegrationCard api={api} botId="bot-a" />)
    const toggle = await screen.findByRole("checkbox", { name: "Ativar Telegram" })
    const token = screen.getByLabelText("Token do bot")
    const guidance = "Salve o token do bot para ativar o Telegram."

    await user.click(toggle)
    fireEvent.change(token, { target: { value: TOKEN } })

    expect(toggle).toBeDisabled()
    expect(toggle).not.toBeChecked()
    expect(toggle).toHaveAccessibleDescription(guidance)
    expect(token).toHaveAccessibleDescription(guidance)
    expect(screen.getByText(guidance)).toBeVisible()
    expect(screen.getByRole("status")).toHaveTextContent("Desligado")
    expect(api.calls.some((call) => call.route === "PUT /bots/:id/integrations/telegram")).toBe(false)
  })

  it("lets an earlier configuration enabled without a saved token be turned off", async () => {
    const api = createMockApi()
    await api.request("PUT /bots/:id/integrations/telegram", { enabled: true }, { id: "bot-a" })
    render(<TelegramIntegrationCard api={api} botId="bot-a" />)
    const toggle = await screen.findByRole("checkbox", { name: "Ativar Telegram" })

    expect(toggle).toBeChecked()
    expect(toggle).toBeEnabled()
    expect(screen.getByRole("status")).toHaveTextContent("Salve o token do bot do Telegram.")

    fireEvent.click(toggle)

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Desligado"))
    expect(api.calls.at(-1)).toMatchObject({ route: "PUT /bots/:id/integrations/telegram", input: { enabled: false } })
    expect(toggle).not.toBeChecked()
    expect(toggle).toBeDisabled()

    fireEvent.change(screen.getByLabelText("Token do bot"), { target: { value: TOKEN } })
    fireEvent.click(screen.getByRole("button", { name: "Salvar token" }))

    await waitFor(() => expect(screen.getByLabelText("Token do bot")).toHaveAttribute("placeholder", "Token salvo"))
    expect(toggle).not.toBeChecked()
    expect(screen.getByRole("status")).toHaveTextContent("Desligado")
  })

  it("requires a new saved token after removing the current token", async () => {
    const api = createMockApi()
    await api.request("PUT /bots/:id/integrations/telegram", { token: TOKEN, enabled: true }, { id: "bot-a" })
    render(<TelegramIntegrationCard api={api} botId="bot-a" />)
    const remove = await screen.findByRole("button", { name: "Remover token" })

    fireEvent.click(remove)

    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Ativar Telegram" })).toBeDisabled())
    expect(screen.getByRole("checkbox", { name: "Ativar Telegram" })).not.toBeChecked()
    expect(screen.getByRole("status")).toHaveTextContent("Desligado")
    expect(screen.getByText("Salve o token do bot para ativar o Telegram.")).toBeVisible()
  })

  it("starts off, saves the token write-only and enables the bridge only on request", async () => {
    const api = createMockApi()
    const botId = api.getState().bots[0]?.id ?? ""
    render(<TelegramIntegrationCard api={api} botId={botId} />)
    expect(await screen.findByRole("checkbox", { name: "Ativar Telegram" })).not.toBeChecked()
    expect(screen.getByRole("status")).toHaveTextContent("Desligado")
    fireEvent.change(screen.getByLabelText("Token do bot"), { target: { value: TOKEN } })
    fireEvent.click(screen.getByRole("button", { name: "Salvar token" }))
    await waitFor(() => expect(screen.getByLabelText("Token do bot")).toHaveValue(""))
    expect(screen.getByLabelText("Token do bot")).toHaveAttribute("placeholder", "Token salvo")
    expect(screen.getByRole("status")).toHaveTextContent("Desligado")
    fireEvent.click(screen.getByRole("checkbox", { name: "Ativar Telegram" }))
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Conectado como @touri_mock_bot"))
    fireEvent.change(screen.getByLabelText("IDs de usuário permitidos"), { target: { value: "42, 77" } })
    fireEvent.click(screen.getByRole("button", { name: "Salvar Telegram" }))
    await waitFor(() =>
      expect(api.calls.at(-1)).toMatchObject({
        route: "PUT /bots/:id/integrations/telegram",
        input: { allowedUserIds: ["42", "77"], homeChatId: null, forwardRoutines: false },
      }),
    )
    const tokenWrites = api.calls.filter(
      (call) => call.route === "PUT /bots/:id/integrations/telegram" && "token" in (call.input as object),
    )
    expect(tokenWrites).toHaveLength(1)
    expect(t("Ativar Telegram", {}, "en")).toBe("Enable Telegram")
  })

  it("offers to allow the last refused sender in one click", async () => {
    const telegram: TelegramIntegration = {
      config: { enabled: true, allowedUserIds: [], homeChatId: null, forwardRoutines: false },
      tokenSaved: true,
      status: { state: "connected", username: "touri_bot", error: null },
      lastRejected: { userId: "77", name: "Ana", at: 1 },
    }
    const request = vi.fn(async (route: string, input: unknown) => {
      if (route === "PUT /bots/:id/integrations/telegram")
        return {
          telegram: { ...telegram, config: { ...telegram.config, ...(input as object) } },
        }
      return { telegram }
    })
    const api = { request, subscribe: () => () => undefined, isMock: true } as unknown as UiApi
    render(<TelegramIntegrationCard api={api} botId="bot-1" />)
    expect(await screen.findByText("Pedido de Ana (ID 77)")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Permitir" }))
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith(
        "PUT /bots/:id/integrations/telegram",
        { allowedUserIds: ["77"] },
        { id: "bot-1" },
      ),
    )
    await waitFor(() => expect(screen.queryByText("Pedido de Ana (ID 77)")).toBeNull())
  })

  it("clears the entered token and settings when the selected bot changes", async () => {
    const api = createMockApi()
    const { rerender } = render(<TelegramIntegrationCard api={api} botId="bot-a" />)
    await screen.findByLabelText("Token do bot")
    fireEvent.change(screen.getByLabelText("Token do bot"), { target: { value: TOKEN } })
    fireEvent.change(screen.getByLabelText("IDs de usuário permitidos"), { target: { value: "42" } })
    rerender(<TelegramIntegrationCard api={api} botId="bot-b" />)
    await screen.findByLabelText("Token do bot")
    expect(screen.getByLabelText("Token do bot")).toHaveValue("")
    expect(screen.getByLabelText("IDs de usuário permitidos")).toHaveValue("")
    expect(screen.getByRole("button", { name: "Salvar token" })).toBeDisabled()
  })

  it("ignores a late settings response from the previously selected bot", async () => {
    let release = (_response: unknown) => {}
    const pending = new Promise((resolve) => {
      release = resolve
    })
    const telegram: TelegramIntegration = {
      config: { enabled: false, allowedUserIds: ["77"], homeChatId: null, forwardRoutines: false },
      tokenSaved: false,
      status: { state: "off", username: null, error: null },
      lastRejected: null,
    }
    const request = vi.fn((_route: string, _input: unknown, path: { id: string }) =>
      path.id === "bot-a" ? pending : Promise.resolve({ telegram }),
    )
    const api = { request, subscribe: () => () => undefined, isMock: true } as unknown as UiApi
    const { rerender } = render(<TelegramIntegrationCard api={api} botId="bot-a" />)
    rerender(<TelegramIntegrationCard api={api} botId="bot-b" />)
    await screen.findByLabelText("IDs de usuário permitidos")
    expect(screen.getByLabelText("IDs de usuário permitidos")).toHaveValue("77")
    await act(async () => {
      release({ telegram: { ...telegram, config: { ...telegram.config, allowedUserIds: ["42"] } } })
    })
    await waitFor(() => expect(screen.getByLabelText("IDs de usuário permitidos")).toHaveValue("77"))
  })

  it("provides Portuguese and English for token guidance and connection status errors", () => {
    expect(t("Salve o token do bot para ativar o Telegram.")).toBe("Salve o token do bot para ativar o Telegram.")
    expect(t("Salve o token do bot para ativar o Telegram.", {}, "en")).toBe("Save the bot token to enable Telegram.")
    expect(t("Salve o token do bot do Telegram.", {}, "en")).toBe("Save the Telegram bot token.")
    expect(t("Token inválido ou revogado.", {}, "en")).toBe("Invalid or revoked token.")
    expect(t("Não foi possível conectar ao Telegram. Confira sua conexão e tente novamente.", {}, "en")).toBe(
      "Could not connect to Telegram. Check your connection and try again.",
    )
  })
})
