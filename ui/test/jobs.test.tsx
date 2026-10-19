import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { ConversationStart } from "../src/components/ConversationStart"
import { getJobTemplates, JOB_GROUP_IDS, jobGroupName, NOT_SURE_JOB_ID } from "../src/features/jobs/catalog"
import { JobPicker } from "../src/features/jobs/JobPicker"
import { dictionaries, type Locale, t } from "../src/i18n"

afterEach(cleanup)

it("offers 31 original jobs with stable unique ids and complete copy in both languages", () => {
  const portuguese = getJobTemplates()
  expect(portuguese).toHaveLength(31)
  expect(new Set(portuguese.map((job) => job.id)).size).toBe(31)
  expect(portuguese.some((job) => job.id === NOT_SURE_JOB_ID)).toBe(false)
  expect(getJobTemplates("en").map((job) => job.id)).toEqual(portuguese.map((job) => job.id))
  for (const locale of ["pt-BR", "en"] as const) {
    const dictionary = dictionaries[locale]
    for (const group of JOB_GROUP_IDS) {
      expect(getJobTemplates(locale).filter((job) => job.group === group)).toHaveLength(group === "daily" ? 6 : 5)
      expect(jobGroupName(group, locale)).not.toContain("jobs.")
      expect(Object.hasOwn(dictionary, `jobs.group.${group}`)).toBe(true)
    }
    for (const job of getJobTemplates(locale)) {
      expect(job.id).toMatch(/^[a-z]+(?:-[a-z]+)*$/)
      for (const field of ["name", "description", "roleLine", "task", "prompts"]) {
        const key = `jobs.${job.id}.${field}`
        expect(dictionary[key as keyof typeof dictionary]?.trim()).toBeTruthy()
        expect(dictionary[key as keyof typeof dictionary]).not.toBe(key)
      }
      for (const field of [job.name, job.description, job.roleLine, job.instructions]) expect(field.trim()).not.toBe("")
      expect(job.instructions).not.toMatch(/\{task\}/)
      expect(job.instructions).toContain(job.name)
      expect(job.instructions).toContain(job.roleLine)
      expect(job.starterPrompts).toHaveLength(3)
      expect(new Set(job.starterPrompts).size).toBe(3)
      expect(job.starterPrompts.every((prompt) => prompt.trim().length > 0)).toBe(true)
      expect(job.instructions.split("\n").length).toBeGreaterThanOrEqual(4)
      expect(job.instructions.split("\n").length).toBeLessThanOrEqual(8)
      expect(job.instructions).toContain(
        locale === "en" ? "computer running touri" : "computador onde o touri está rodando",
      )
      expect(job.instructions).toContain(locale === "en" ? "user’s own login" : "login do usuário")
      expect(job.instructions).not.toContain("CLI")
      expect(job.instructions).toContain(locale === "en" ? "browser" : "navegador")
      expect(job.instructions).toContain(
        locale === "en" ? "permission before changing files" : "permissão antes de mudar arquivos",
      )
    }
  }
})

it.each([
  ["pt-BR", "notes-in-order", "Organize estas anotações por assunto."],
  ["pt-BR", "focused-week", "Ajude a escolher três prioridades para esta semana."],
  ["pt-BR", "packing-checklist", "Ajude a montar a mala para minha próxima viagem."],
  ["pt-BR", "study-blocks", "Divida este assunto em sessões curtas de estudo."],
  ["en", "notes-in-order", "Organize these notes by topic."],
  ["en", "focused-week", "Help me choose three priorities for this week."],
  ["en", "packing-checklist", "Help me pack for my next trip."],
  ["en", "study-blocks", "Break this subject into short study sessions."],
] as const)(
  "offers a source-free example for %s job %s even when the bot is named QA Café",
  (locale, jobId, _prompt) => {
    const bot = createMockApi().getState().bots[0]
    const job = getJobTemplates(locale).find((job) => job.id === jobId)
    if (!bot || !job) throw new Error("Missing catalog fixture")
    const choose = vi.fn()
    render(<ConversationStart bot={{ ...bot, name: "QA Café", roleLine: job.roleLine }} onChoose={choose} />)
    expect(screen.getAllByRole("button")).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: "Usar exemplo" }))
    expect(choose).toHaveBeenCalledExactlyOnceWith(t("onboarding.examplePrompt"))
    expect(screen.queryByRole("button", { name: /plano de testes|contexto deste projeto/ })).toBeNull()
  },
)

const Picker = ({ locale = "pt-BR" }: { locale?: Locale }) => {
  const [value, setValue] = useState(NOT_SURE_JOB_ID)
  return <JobPicker locale={locale} value={value} onChange={(job) => setValue(job?.id ?? NOT_SURE_JOB_ID)} />
}

it("searches names, descriptions and groups without requiring accents", () => {
  render(<Picker />)
  expect(screen.getAllByRole("radio")).toHaveLength(32)
  expect(screen.getByRole("radio", { name: "Ainda não sei" })).toBeChecked()
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "codigo" } })
  expect(screen.getAllByRole("radio")).toHaveLength(6)
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "anotacoes" } })
  expect(screen.getByRole("radio", { name: "Caderno em ordem" })).toBeVisible()
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzzz" } })
  expect(screen.getByRole("status")).toHaveTextContent("Nenhum trabalho encontrado")
  expect(screen.getByRole("radio", { name: "Ainda não sei" })).toBeChecked()
})

it("supports keyboard selection, wrapping and resetting to an unspecified job", async () => {
  const user = userEvent.setup()
  render(<Picker />)
  screen.getByRole("radio", { name: "Ainda não sei" }).focus()
  await user.keyboard("{ArrowDown}")
  const first = screen.getByRole("radio", { name: "Caderno em ordem" })
  expect(first).toHaveFocus()
  expect(first).toBeChecked()
  await user.keyboard("{End}")
  expect(screen.getByRole("radio", { name: "Registro de decisões" })).toBeChecked()
  await user.keyboard("{ArrowRight}")
  expect(screen.getByRole("radio", { name: "Ainda não sei" })).toHaveFocus()
  expect(screen.getByRole("radio", { name: "Ainda não sei" })).toBeChecked()
  await user.keyboard("{ArrowUp}{Home}")
  expect(screen.getByRole("radio", { name: "Ainda não sei" })).toBeChecked()
})

it("renders the picker in English", () => {
  render(<Picker locale="en" />)
  expect(screen.getByRole("radiogroup", { name: "What does it do?" })).toBeVisible()
  expect(screen.getByRole("radio", { name: "Not sure yet" })).toBeChecked()
  expect(screen.getByRole("searchbox", { name: "Search jobs" })).toBeVisible()
})
