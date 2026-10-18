import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { getJobTemplates, NOT_SURE_JOB_ID } from "../src/features/jobs/catalog"
import { JobPicker } from "../src/features/jobs/JobPicker"
import { dictionaries, t } from "../src/i18n"

afterEach(cleanup)

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
  expect(within(dialog).getByRole("textbox", { name: "Nome do grupo" })).toHaveValue("Equipe com Bia")
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
    name: "Equipe com Bia",
    memberIds: api.getState().bots.map((bot) => bot.id),
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

const makeFirstBotApi = async () => {
  const api = await makeEmptyApi()
  const job = getJobTemplates()[0]
  if (!job) throw new Error("Missing job fixture")
  await api.request("POST /bots", {
    name: "Clara",
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
  fireEvent.change(screen.getByLabelText("Nome", { exact: true }), { target: { value: name } })
  await screen.findByText(/conectado neste/)
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Criar bot", exact: true }))
  await screen.findByRole("textbox", { name: `Mensagem para ${name}` })
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
}
