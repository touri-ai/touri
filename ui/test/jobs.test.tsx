import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, expect, it } from "vitest"
import { getJobTemplates, JOB_GROUP_IDS, jobGroupName, NOT_SURE_JOB_ID } from "../src/features/jobs/catalog"
import { JobPicker } from "../src/features/jobs/JobPicker"
import { dictionaries, type Locale } from "../src/i18n"

afterEach(cleanup)

it("offers 30 original jobs with stable unique ids and complete copy in both languages", () => {
  const portuguese = getJobTemplates()
  expect(portuguese).toHaveLength(30)
  expect(new Set(portuguese.map((job) => job.id)).size).toBe(30)
  expect(portuguese.some((job) => job.id === NOT_SURE_JOB_ID)).toBe(false)
  expect(getJobTemplates("en").map((job) => job.id)).toEqual(portuguese.map((job) => job.id))
  for (const locale of ["pt-BR", "en"] as const) {
    const dictionary = dictionaries[locale]
    for (const group of JOB_GROUP_IDS) {
      expect(getJobTemplates(locale).filter((job) => job.group === group)).toHaveLength(5)
      expect(jobGroupName(group, locale)).not.toContain("jobs.")
      expect(Object.hasOwn(dictionary, `jobs.group.${group}`)).toBe(true)
    }
    for (const job of getJobTemplates(locale)) {
      expect(job.id).toMatch(/^[a-z]+(?:-[a-z]+)*$/)
      for (const field of ["name", "description", "roleLine", "task"]) {
        const key = `jobs.${job.id}.${field}`
        expect(dictionary[key as keyof typeof dictionary]?.trim()).toBeTruthy()
        expect(dictionary[key as keyof typeof dictionary]).not.toBe(key)
      }
      for (const field of [job.name, job.description, job.roleLine, job.instructions]) expect(field.trim()).not.toBe("")
      expect(job.instructions).not.toMatch(/\{task\}/)
      expect(job.instructions.split("\n").length).toBeGreaterThanOrEqual(4)
      expect(job.instructions.split("\n").length).toBeLessThanOrEqual(8)
      expect(job.instructions).toContain("Mac")
      expect(job.instructions).toContain("CLI")
      expect(job.instructions).toContain(locale === "en" ? "browser" : "navegador")
      expect(job.instructions).toContain(
        locale === "en" ? "permission before changing files" : "permissão antes de mudar arquivos",
      )
    }
  }
})

const Picker = ({ locale = "pt-BR" }: { locale?: Locale }) => {
  const [value, setValue] = useState(NOT_SURE_JOB_ID)
  return <JobPicker locale={locale} value={value} onChange={(job) => setValue(job?.id ?? NOT_SURE_JOB_ID)} />
}

it("searches names, descriptions and groups without requiring accents", () => {
  render(<Picker />)
  expect(screen.getAllByRole("radio")).toHaveLength(31)
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
