import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { WebPushSettings } from "../src/components/WebPushSettings"
import { t } from "../src/i18n"
import type { WebPushClient } from "../src/webPush"

afterEach(cleanup)

const getClient = (subscribed = false): WebPushClient => ({
  getStatus: vi.fn().mockResolvedValue({ supported: true, subscribed }),
  enable: vi.fn().mockResolvedValue(undefined),
  disable: vi.fn().mockResolvedValue(undefined),
  test: vi.fn().mockResolvedValue(undefined),
})

it("only requests permission after an explicit enable click", async () => {
  const client = getClient()
  render(<WebPushSettings enabled client={client} />)
  const enable = await screen.findByRole("button", { name: "Ativar neste aparelho" })
  expect(client.enable).not.toHaveBeenCalled()
  vi.mocked(client.getStatus).mockResolvedValue({ supported: true, subscribed: true })

  fireEvent.click(enable)

  expect(await screen.findByRole("button", { name: "Desativar neste aparelho" })).toBeVisible()
  expect(client.enable).toHaveBeenCalledTimes(1)
})

it("tests the current device explicitly and asks for real receipt verification", async () => {
  const client = getClient(true)
  render(<WebPushSettings enabled client={client} />)
  const test = await screen.findByRole("button", { name: "Testar aviso" })

  fireEvent.click(test)

  expect(await screen.findByText("Teste enviado. Confira se o aviso apareceu no sistema.")).toBeVisible()
  expect(client.test).toHaveBeenCalledTimes(1)
})

it("reports failed delivery without a success claim and allows another attempt", async () => {
  const client = getClient(true)
  vi.mocked(client.test).mockRejectedValue(new Error("Synthetic delivery failure"))
  render(<WebPushSettings enabled client={client} />)
  const test = await screen.findByRole("button", { name: "Testar aviso" })

  fireEvent.click(test)

  expect(await screen.findByRole("alert")).toBeVisible()
  expect(screen.queryByText("Teste enviado. Confira se o aviso apareceu no sistema.")).toBeNull()
  expect(test).toBeEnabled()
})

it("disables the server subscription before presenting this device as off", async () => {
  const client = getClient(true)
  render(<WebPushSettings enabled client={client} />)
  const disable = await screen.findByRole("button", { name: "Desativar neste aparelho" })
  vi.mocked(client.getStatus).mockResolvedValue({ supported: true, subscribed: false })

  fireEvent.click(disable)

  await waitFor(() => expect(client.disable).toHaveBeenCalledTimes(1))
  expect(await screen.findByRole("button", { name: "Ativar neste aparelho" })).toBeVisible()
})

it("explains unsupported environments without prompting for permission", async () => {
  const client = getClient()
  vi.mocked(client.getStatus).mockResolvedValue({ supported: false, subscribed: false })
  render(<WebPushSettings enabled client={client} />)

  expect(
    await screen.findByText(
      "Este navegador ainda não permite avisos aqui. Abra o touri instalado pela tela de início usando HTTPS.",
    ),
  ).toBeVisible()
  expect(client.enable).not.toHaveBeenCalled()
  expect(screen.queryByRole("button")).toBeNull()
})

it("translates device controls and all push event types", () => {
  expect(t("Ativar neste aparelho", {}, "en")).toBe("Enable on this device")
  expect(t("O bot terminou. Abra a conversa para ver o resultado.", {}, "en")).toContain("The bot finished")
  expect(t("O bot precisa de você. Abra a conversa para responder.", {}, "en")).toContain("needs you")
  expect(t("A tarefa falhou. Abra a conversa para ver o que aconteceu.", {}, "en")).toContain("failed")
  expect(t("Uma revisão está pronta. Abra a conversa para conferir.", {}, "en")).toContain("review is ready")
})
