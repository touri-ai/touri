import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { SettingsModal } from "../src/components/SettingsModal"
import { t } from "../src/i18n"

afterEach(cleanup)

it("saves global, per-bot, per-type and quiet-hour preferences from web settings", async () => {
  const api = createMockApi()
  const { settings } = await api.request("GET /settings", {})
  const onSave = vi.fn(async () => undefined)
  render(
    <SettingsModal
      settings={settings}
      onClose={() => undefined}
      onSave={onSave}
      initialSection="notifications"
      api={api}
    />,
  )
  fireEvent.click(screen.getByText("Escolher avisos e horário silencioso"))
  await screen.findByRole("option", { name: "mark" })

  expect(screen.queryByRole("combobox", { name: "Aprovação" })).toBeNull()
  expect(screen.queryByRole("combobox", { name: "Pergunta" })).toBeNull()
  expect(screen.queryByRole("combobox", { name: "Precisa de você" })).toBeNull()
  expect(
    screen.getByText(
      "Aprovações, perguntas e pedidos para você assumir continuam alertando durante o horário silencioso.",
    ),
  ).toBeVisible()

  fireEvent.change(screen.getByLabelText("Avisar sobre"), { target: { value: "all" } })
  fireEvent.change(screen.getByLabelText("Aviso do bot"), { target: { value: "off" } })
  fireEvent.change(screen.getByLabelText("Aplicar a"), { target: { value: "bot-mark" } })
  fireEvent.change(screen.getByLabelText("Resposta falhou"), { target: { value: "off" } })
  fireEvent.click(screen.getByLabelText("Ativar horário silencioso"))
  fireEvent.change(screen.getByLabelText("Das"), { target: { value: "23:00" } })
  fireEvent.click(screen.getByRole("button", { name: "Salvar preferências" }))

  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      notificationPreferences: {
        digest: "all",
        types: { notice: false },
        bots: { "bot-mark": { types: { "turn-failed": false } } },
        quietHours: { enabled: true, start: "23:00", end: "08:00" },
      },
    }),
  )
  expect(
    screen.getByText(
      "Com a página fechada, não há som nem avisos em segundo plano. Ao voltar, você vê as solicitações pendentes.",
    ),
  ).toBeVisible()
})

it("summarizes requests waiting when the page opens and lists them in the notification center", async () => {
  const api = createMockApi()
  api.notify({
    kind: "approval",
    botId: "bot-mark",
    title: "Revisar arquivo",
    body: "Autorizar alteração",
    requestId: "request-demo",
  })
  api.notify({
    kind: "question",
    botId: "bot-mark",
    title: "Question",
    body: "Qual pasta usar?",
    requestId: "question-demo",
  })
  render(<App kernel={{ services: { api } }} />)

  const summary = await screen.findByText("Você tem 2 solicitações pendentes.")
  fireEvent.click(screen.getByRole("button", { name: "Notificações, 2 precisam de atenção" }))

  expect(summary).toBeVisible()
  expect(screen.getByRole("region", { name: "Central de notificações" })).toHaveTextContent("Qual pasta usar?")
  expect(screen.getByRole("button", { name: "Aprovar", exact: true })).toBeVisible()
})

it("keeps the return summary hidden when the page opened without pending requests", async () => {
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  act(() => {
    api.notify({
      kind: "question",
      botId: "bot-mark",
      title: "Question",
      body: "Qual pasta usar?",
      requestId: "live-question",
    })
  })

  expect(screen.queryByText(/Você tem .* solicitaç/)).toBeNull()
  expect(screen.getByRole("button", { name: "Notificações, 1 precisa de atenção" })).toBeVisible()
})

it("shows a plain no-news result for historical notification bodies", async () => {
  const api = createMockApi()
  api.notify({ kind: "done", botId: "bot-mark", title: "Done", body: "Texto bruto do modelo\nNO_NOTIFICATION" })
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  fireEvent.click(screen.getByRole("button", { name: "Notificações", exact: true }))

  expect(screen.getByText("Rotina concluída sem novidades.")).toBeVisible()
  expect(screen.queryByText(/Texto bruto do modelo|NO_NOTIFICATION/)).toBeNull()
})

it("preserves ordinary explanations of the marker in historical notifications", async () => {
  const api = createMockApi()
  const body = "O código NO_NOTIFICATION indica uma execução sem novidades."
  api.notify({ kind: "done", botId: "bot-mark", title: "Done", body })
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  fireEvent.click(screen.getByRole("button", { name: "Notificações", exact: true }))

  expect(screen.getByText(body)).toBeVisible()
  expect(screen.queryByText("Rotina concluída sem novidades.")).toBeNull()
})

it("provides English preferences and rate-limit guidance", () => {
  expect(t("Aviso do bot", {}, "en")).toBe("Bot notice")
  expect(t("Routine finished with no news.")).toBe("Rotina concluída sem novidades.")
  expect(t("Routine finished with no news.", {}, "en")).toBe("Routine finished with no news.")
  expect(t("Somente o que precisa de mim", {}, "en")).toBe("Only what needs me")
  expect(t("Também resultados concluídos", {}, "en")).toBe("Also completed results")
  expect(t("Horário silencioso", {}, "en")).toBe("Quiet hours")
  expect(t("Você tem {n} solicitações pendentes.", { n: 1 })).toBe("Você tem 1 solicitação pendente.")
  expect(t("Você tem {n} solicitações pendentes.", { n: 1 }, "en")).toBe("You have 1 pending request.")
  expect(t("Rotina concluída sem novidades.", {}, "en")).toBe("Routine finished with no news.")
  expect(t("Notifications are limited to one every 30 seconds. Wait before trying again.")).toContain("30 segundos")
})
