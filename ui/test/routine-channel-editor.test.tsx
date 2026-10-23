import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { expect, it } from "vitest"
import App from "../src/App"
import { t } from "../src/i18n"
import { getRoutineChannelFixture } from "./fixtures/routine-channel"

const openRoutineScreen = async (api: Awaited<ReturnType<typeof getRoutineChannelFixture>>["api"]) => {
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.click(await screen.findByRole("button", { name: "Ações de mark" }))
  fireEvent.click(await screen.findByRole("menuitem", { name: "Rotinas", exact: true }))

  return screen.findByRole("region", { name: "Rotinas", exact: true })
}

it("edits a channel routine globally and saves its existing channel conversation", async () => {
  const { api, group, eligibleGroup, otherGroup, thread, routine } = await getRoutineChannelFixture()
  const routines = await openRoutineScreen(api)

  fireEvent.click(within(routines).getByRole("button", { name: `Editar ${routine.name}` }))

  const editor = screen.getByRole("dialog", { name: "Quando?" })
  const destination = within(editor).getByRole("combobox", { name: "Destino dos resultados" })
  expect(destination).toHaveValue(`group:${group.id}`)
  expect(within(destination).getByRole("option", { selected: true })).toHaveTextContent(group.name)
  expect(within(destination).getByRole("option", { name: `Conversa do grupo ${eligibleGroup.name}` })).toBeEnabled()
  expect(within(destination).queryByRole("option", { name: `Conversa do grupo ${otherGroup.name}` })).toBeNull()
  expect(within(editor).getByRole("button", { name: "Revisar rotina" })).toBeEnabled()

  fireEvent.change(within(editor).getByRole("textbox", { name: "Tarefa", exact: true }), {
    target: { value: "Resuma também as próximas tarefas fictícias." },
  })
  fireEvent.click(within(editor).getByRole("button", { name: "Revisar rotina" }))

  expect(within(editor).getByText(`Conversa do grupo ${group.name}`, { exact: true })).toBeVisible()
  fireEvent.click(within(editor).getByRole("button", { name: "Ativar rotina" }))

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  const saved = (await api.request("GET /routines", {})).routines.find((item) => item.id === routine.id)
  expect(saved).toMatchObject({
    groupId: group.id,
    resultsThreadId: thread.id,
    continuity: "results-thread",
    prompt: "Resuma também as próximas tarefas fictícias.",
    enabled: true,
  })
})

it("creates globally for an eligible channel and refreshes destinations when switching bots", async () => {
  const { api, bot, otherBot, group, otherGroup } = await getRoutineChannelFixture()
  const routines = await openRoutineScreen(api)

  fireEvent.click(within(routines).getByRole("button", { name: "Criar rotina", exact: true }))

  const editor = screen.getByRole("dialog")
  const destination = within(editor).getByRole("combobox", { name: "Destino dos resultados" })
  fireEvent.change(destination, { target: { value: `group:${group.id}` } })
  fireEvent.change(within(editor).getByRole("combobox", { name: "Bot", exact: true }), {
    target: { value: otherBot.id },
  })

  expect(destination).toHaveValue("main-thread")
  expect(within(destination).queryByRole("option", { name: `Conversa do grupo ${group.name}` })).toBeNull()
  expect(within(destination).getByRole("option", { name: `Conversa do grupo ${otherGroup.name}` })).toBeEnabled()

  fireEvent.change(destination, { target: { value: `group:${otherGroup.id}` } })
  fireEvent.change(within(editor).getByRole("textbox", { name: "Tarefa", exact: true }), {
    target: { value: "Confira as tarefas fictícias de pesquisa." },
  })
  fireEvent.click(within(editor).getByRole("button", { name: "Revisar rotina" }))
  fireEvent.click(within(editor).getByRole("button", { name: "Ativar rotina" }))

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  const saved = api.calls.find((call) => call.route === "POST /routines")
  expect(saved?.input).toMatchObject({
    botId: otherBot.id,
    groupId: otherGroup.id,
    resultsThreadId: null,
    continuity: "results-thread",
    enabled: true,
  })
  expect(saved?.input).not.toMatchObject({ botId: bot.id })
})

it.each(["missing", "not-member"])(
  "keeps an unavailable %s channel explicit until the user changes it",
  async (state) => {
    const { api, group, otherBot, routine } = await getRoutineChannelFixture()
    const groupId = state === "missing" ? "missing-channel" : group.id
    if (state === "missing")
      await api.request("PATCH /routines/:id", { groupId, resultsThreadId: null }, { id: routine.id })
    if (state === "not-member") await api.request("PATCH /groups/:id", { memberIds: [otherBot.id] }, { id: group.id })
    const writes = api.calls.filter((call) => call.route === "PATCH /routines/:id").length
    const routines = await openRoutineScreen(api)

    fireEvent.click(within(routines).getByRole("button", { name: `Editar ${routine.name}` }))

    const editor = screen.getByRole("dialog")
    const destination = within(editor).getByRole("combobox", { name: "Destino dos resultados" })
    expect(destination).toHaveValue(`group:${groupId}`)
    const selected = within(destination).getByRole("option", { selected: true })
    expect(selected).toHaveTextContent(state === "missing" ? "Canal indisponível" : "bot fora do canal")
    expect(selected).toBeDisabled()
    expect(within(editor).getByRole("button", { name: "Revisar rotina" })).toBeDisabled()
    expect(api.calls.filter((call) => call.route === "PATCH /routines/:id")).toHaveLength(writes)

    fireEvent.change(destination, { target: { value: "main-thread" } })

    expect(destination).toHaveValue("main-thread")
    expect(within(editor).getByRole("button", { name: "Revisar rotina" })).toBeEnabled()
  },
)

it("provides unavailable channel labels in both languages", () => {
  expect(t("Canal indisponível", {}, "pt-BR")).toBe("Canal indisponível")
  expect(t("Canal indisponível", {}, "en")).toBe("Channel unavailable")
  expect(t("Canal {group} (bot fora do canal)", { group: "Pesquisa" }, "pt-BR")).toBe(
    "Canal Pesquisa (bot fora do canal)",
  )
  expect(t("Canal {group} (bot fora do canal)", { group: "Research" }, "en")).toBe(
    "Channel Research (bot is not a member)",
  )
})
