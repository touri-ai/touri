import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { getJobTemplates, NOT_SURE_JOB_ID } from "../src/features/jobs/catalog"
import { JobPicker } from "../src/features/jobs/JobPicker"
import { TeamNextStep } from "../src/features/jobs/TeamNextStep"
import { dictionaries, t } from "../src/i18n"
import { getTeamRoutineDraft } from "../src/routineDraft"

afterEach(cleanup)

it.each(["pt-BR", "en"] as const)("offers an accessible routine draft and dismiss button in %s", (locale) => {
  const api = createMockApi()
  const bots = api.getState().bots.slice(0, 2)
  const [partner, bot] = bots
  if (!bot || !partner) throw new Error("Missing bot fixtures")
  const openRoutine = vi.fn()
  render(
    <TeamNextStep
      bots={bots}
      selectedBotId={bot.id}
      followup={{ botId: bot.id, partnerId: partner.id }}
      onChooseJob={vi.fn()}
      onGroup={vi.fn()}
      onRoutine={openRoutine}
      onDismissFollowup={vi.fn()}
      locale={locale}
    />,
  )

  fireEvent.click(screen.getByRole("button", { name: t("Create a routine?", {}, locale) }))

  expect(openRoutine).toHaveBeenCalledWith(bot)
  expect(screen.getByRole("button", { name: t("Dismiss next step", {}, locale) })).toHaveAccessibleName(
    t("Dismiss next step", {}, locale),
  )
  expect(dictionaries[locale]["Create a routine?"]).toBe(locale === "pt-BR" ? "Criar uma rotina?" : "Create a routine?")
})

it.each(["pt-BR", "en"] as const)("prefills a paused routine and translated starter in %s", (locale) => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  const job = getJobTemplates(locale).find((job) => job.id === "focused-week")
  if (!bot || !job) throw new Error("Missing job fixtures")

  const recurring = getTeamRoutineDraft({ ...bot, roleLine: job.roleLine, instructions: job.instructions }, locale)
  const custom = getTeamRoutineDraft({ ...bot, instructions: "Organizar as notas da equipe." }, locale)
  const starter = getTeamRoutineDraft({ ...bot, name: "Bia", roleLine: "", instructions: "" }, locale)

  expect(recurring).toMatchObject({
    botId: bot.id,
    name: job.name,
    prompt: job.instructions,
    cron: job.suggestedCron,
    enabled: false,
  })
  expect(custom).toMatchObject({ botId: bot.id, prompt: "Organizar as notas da equipe.", enabled: false })
  expect(starter).toMatchObject({
    name: locale === "pt-BR" ? "Rotina com Bia" : "Routine with Bia",
    prompt:
      locale === "pt-BR"
        ? "Revise as tarefas de hoje e sugira os próximos passos."
        : "Review today's tasks and suggest next steps.",
    enabled: false,
  })
  expect(api.calls).toHaveLength(0)
})

it("waits for the first bot and persists dismissal of the single optional next step", async () => {
  const api = await makeEmptyApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("button", { name: "Criar meu primeiro bot" })

  expect(screen.queryByRole("region", { name: "Coloque outro bot para trabalhar com você" })).toBeNull()
  await createBot("Clara", true)

  const suggestion = await screen.findByRole("region", { name: "Coloque outro bot para trabalhar com você" })
  expect(within(suggestion).getAllByRole("listitem")).toHaveLength(3)
  expect(suggestion).toHaveTextContent("Os bots podem colaborar em um grupo e seguir rotinas.")
  expect(screen.queryByRole("button", { name: /Trabalhar em grupo com/ })).toBeNull()

  fireEvent.click(within(suggestion).getByRole("button", { name: "Dispensar próximo passo" }))
  cleanup()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para Clara" })

  expect(screen.queryByRole("region", { name: "Coloque outro bot para trabalhar com você" })).toBeNull()
  await createBot("Bia")

  expect(screen.getByRole("button", { name: "Trabalhar em grupo com Clara?" })).toBeVisible()

  fireEvent.click(screen.getByRole("button", { name: "Dispensar próximo passo" }))

  expect(document.querySelector(".team-next-step")).toBeNull()
})

it("prefills a complementary job and offers a group draft with an explicit save", async () => {
  const user = userEvent.setup()
  const api = await makeFirstBotApi()
  render(<App kernel={{ services: { api } }} />)
  const suggestion = await screen.findByRole("region", { name: "Coloque outro bot para trabalhar com você" })
  const job = getJobTemplates().find((job) => job.id === "focused-week")
  if (!job) throw new Error("Missing job fixture")

  expect(within(suggestion).queryByRole("button", { name: "Caderno em ordem" })).toBeNull()
  fireEvent.click(within(suggestion).getByRole("button", { name: job.name }))
  expect(screen.getByRole("radio", { name: job.name })).toBeChecked()
  expect(screen.getByRole("radio", { name: "Caderno em ordem" })).toHaveAccessibleDescription(
    /Você já tem um bot cuidando disso\./,
  )
  await submitBot("Bia")

  expect(api.calls.findLast((call) => call.route === "POST /bots")?.input).toMatchObject({
    roleLine: job.roleLine,
    instructions: job.instructions,
  })
  expect(document.querySelectorAll(".team-next-step")).toHaveLength(1)
  expect(screen.queryByRole("heading", { name: "Coloque outro bot para trabalhar com você" })).toBeNull()
  const offer = screen.getByRole("button", { name: "Trabalhar em grupo com Clara?" })

  offer.focus()
  await user.keyboard("{Enter}")
  const dialog = screen.getByRole("dialog", { name: "Criar grupo" })
  expect(within(dialog).getByRole("textbox", { name: "Nome do grupo" })).toHaveValue("Equipe com Clara")
  expect(within(dialog).getByRole("checkbox", { name: "Clara" })).toBeChecked()
  expect(within(dialog).getByRole("checkbox", { name: "Bia" })).toBeChecked()
  await user.keyboard("{Enter}")

  expect(api.calls.filter((call) => call.route === "POST /groups")).toHaveLength(0)
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar", exact: true }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  fireEvent.click(offer)
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Criar grupo", exact: true }))

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  expect(api.calls.filter((call) => call.route === "POST /groups")).toHaveLength(1)
  expect(api.calls.find((call) => call.route === "POST /groups")?.input).toMatchObject({
    name: "Equipe com Clara",
    memberIds: api.getState().bots.map((bot) => bot.id),
  })
})

it("keeps a suggested group name within the editor limit when the bot has a long name", async () => {
  const name = "C".repeat(80)
  const api = await makeFirstBotApi(name)
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: `Mensagem para ${name}` })

  await createBot("Bia")
  fireEvent.click(screen.getByRole("button", { name: `Trabalhar em grupo com ${name}?` }))

  const groupName = within(screen.getByRole("dialog")).getByRole("textbox", { name: "Nome do grupo" })
  expect(groupName).toHaveAttribute("maxlength", "80")
  expect(groupName).toHaveValue(`Equipe com ${name}`.slice(0, 80))
})

it("keeps job suggestions independent and remembers followup dismissal after reload and another bot", async () => {
  const api = await makeFirstBotApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para Clara" })
  await createBot("Bia")

  fireEvent.click(screen.getByRole("button", { name: "Dispensar próximo passo" }))
  cleanup()
  render(<App kernel={{ services: { api } }} />)

  const suggestion = await screen.findByRole("region", { name: "Coloque outro bot para trabalhar com você" })
  expect(within(suggestion).getAllByRole("listitem")).toHaveLength(3)
  await createBot("Davi")

  expect(document.querySelector(".team-next-step")).toBeNull()
  expect(screen.queryByRole("button", { name: /Trabalhar em grupo com/ })).toBeNull()
})

it("opens a prefilled routine draft for the new bot and requires review and an activation click", async () => {
  const user = userEvent.setup()
  const api = await makeFirstBotApi()
  const job = getJobTemplates().find((job) => job.id === "focused-week")
  if (!job) throw new Error("Missing job fixture")
  render(<App kernel={{ services: { api } }} />)
  const suggestion = await screen.findByRole("region", { name: "Coloque outro bot para trabalhar com você" })
  fireEvent.click(within(suggestion).getByRole("button", { name: job.name }))
  await submitBot("Bia")
  const bot = api.getState().bots.find((bot) => bot.name === "Bia")
  if (!bot) throw new Error("Missing bot fixture")

  screen.getByRole("button", { name: "Criar uma rotina?" }).focus()
  await user.keyboard("{Enter}")

  const dialog = screen.getByRole("dialog", { name: "Quando?" })
  expect(within(dialog).getByRole("combobox", { name: "Bot", exact: true })).toHaveValue(bot.id)
  expect(within(dialog).getByRole("textbox", { name: "Nome", exact: true })).toHaveValue(job.name)
  expect(within(dialog).getByRole("textbox", { name: "Tarefa" })).toHaveValue(job.instructions)
  expect(within(dialog).getByLabelText("segunda-feira")).toBeChecked()
  expect(within(dialog).getByLabelText("Às")).toHaveValue("09:00")
  await user.keyboard("{Enter}")
  expect(api.calls.filter((call) => call.route === "POST /routines")).toHaveLength(0)
  fireEvent.click(within(dialog).getByRole("button", { name: "Revisar rotina" }))
  const activate = screen.getByRole("button", { name: "Ativar rotina" })
  activate.focus()
  await user.keyboard("{Enter}")
  expect(api.calls.filter((call) => call.route === "POST /routines")).toHaveLength(0)
  fireEvent.click(activate)

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  expect(api.calls.filter((call) => call.route === "POST /routines")).toHaveLength(1)
  expect(api.calls.find((call) => call.route === "POST /routines")?.input).toMatchObject({
    botId: bot.id,
    name: job.name,
    prompt: job.instructions,
    cron: job.suggestedCron,
    enabled: true,
  })
})

it("replaces the followup for the third bot and dismisses it without revealing another banner", async () => {
  const api = await makeFirstBotApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para Clara" })

  await createBot("Bia")
  expect(screen.getByRole("button", { name: "Trabalhar em grupo com Clara?" })).toBeVisible()
  await createBot("Davi")

  expect(document.querySelectorAll(".team-next-step")).toHaveLength(1)
  expect(screen.queryByRole("button", { name: "Trabalhar em grupo com Clara?" })).toBeNull()
  expect(screen.getByRole("button", { name: "Trabalhar em grupo com Bia?" })).toBeVisible()

  fireEvent.click(screen.getByRole("button", { name: "Dispensar próximo passo" }))

  expect(document.querySelector(".team-next-step")).toBeNull()
  expect(api.calls.filter((call) => call.route === "POST /groups" || call.route === "POST /routines")).toHaveLength(0)
})

it.each(["pt-BR", "en"] as const)("describes covered jobs accessibly in %s without disabling them", (locale) => {
  const job = getJobTemplates(locale)[0]
  if (!job) throw new Error("Missing job fixture")
  const change = vi.fn()
  render(<JobPicker value={NOT_SURE_JOB_ID} coveredJobIds={[job.id]} onChange={change} locale={locale} />)

  const option = screen.getByRole("radio", { name: job.name })
  fireEvent.click(option)

  expect(option).toHaveAccessibleDescription(new RegExp(t("You already have a bot taking care of this.", {}, locale)))
  expect(change).toHaveBeenCalledWith(job)
  expect(screen.getAllByText(t("You already have a bot taking care of this.", {}, locale))).toHaveLength(1)
  expect(dictionaries[locale]["Put another bot to work with you"]).not.toBe("")
  expect(dictionaries[locale]["Work in a group with {name}?"]).toContain("{name}")
})

it("recognizes an existing English job when creating another bot in Portuguese", async () => {
  const api = await makeEmptyApi()
  const job = getJobTemplates("en")[0]
  if (!job) throw new Error("Missing job fixture")
  await api.request("POST /bots", { name: "Clara", provider: "codex", roleLine: job.roleLine })
  render(<App kernel={{ services: { api } }} />)
  const suggestion = await screen.findByRole("region", { name: "Coloque outro bot para trabalhar com você" })

  fireEvent.click(screen.getByRole("button", { name: "Criar bot", exact: true }))
  await screen.findByText(/conectado neste/)

  expect(within(suggestion).queryByRole("button", { name: "Caderno em ordem" })).toBeNull()
  expect(screen.getByRole("radio", { name: "Caderno em ordem" })).toHaveAccessibleDescription(
    /Você já tem um bot cuidando disso\./,
  )
  expect(screen.getByRole("radio", { name: "Ainda não sei" })).toBeChecked()
})

const makeEmptyApi = async () => {
  const api = createMockApi()
  const bots = api.getState().bots.map(({ id, name }) => ({ id, name }))
  for (const bot of bots)
    await api.request("DELETE /bots/:id", { name: bot.name, deleteVolumes: false }, { id: bot.id })

  return api
}

const makeFirstBotApi = async (name = "Clara") => {
  const api = await makeEmptyApi()
  const job = getJobTemplates()[0]
  if (!job) throw new Error("Missing job fixture")
  await api.request("POST /bots", {
    name,
    provider: "codex",
    roleLine: job.roleLine,
    instructions: job.instructions,
  })

  return api
}

const createBot = async (name: string, first = false) => {
  fireEvent.click(
    await screen.findByRole("button", { name: first ? "Criar meu primeiro bot" : "Criar bot", exact: true }),
  )
  await submitBot(name)
}

const submitBot = async (name: string) => {
  fireEvent.change(await screen.findByLabelText("Nome", { exact: true }), { target: { value: name } })
  await screen.findByText(/conectado neste/)
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Criar bot", exact: true }))
  await screen.findByRole("textbox", { name: `Mensagem para ${name}` })
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
}
