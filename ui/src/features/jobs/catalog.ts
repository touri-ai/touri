import type { Bot } from "@touri/contracts"
import { type Locale, t } from "../../i18n"

export const JOB_GROUP_IDS = ["daily", "communication", "code", "research", "customers", "operations"] as const
export type JobGroupId = (typeof JOB_GROUP_IDS)[number]
export type JobTemplate = {
  id: string
  group: JobGroupId
  name: string
  description: string
  roleLine: string
  instructions: string
  starterPrompts: string[]
  suggestedCron?: string
}
export const NOT_SURE_JOB_ID = "not-sure-yet"

const definitions = [
  { id: "notes-in-order", group: "daily" },
  { id: "focused-week", group: "daily" },
  { id: "packing-checklist", group: "daily" },
  { id: "study-blocks", group: "daily" },
  { id: "weekly-menu", group: "daily" },
  { id: "team-builder", group: "daily" },
  { id: "clearer-writing", group: "communication" },
  { id: "team-update", group: "communication" },
  { id: "thoughtful-reply", group: "communication" },
  { id: "talk-outline", group: "communication" },
  { id: "meeting-record", group: "communication" },
  { id: "repository-map", group: "code" },
  { id: "critical-tests", group: "code" },
  { id: "change-explainer", group: "code" },
  { id: "dependency-plan", group: "code" },
  { id: "sample-data", group: "code" },
  { id: "sources-together", group: "research" },
  { id: "reading-questions", group: "research" },
  { id: "topic-glossary", group: "research" },
  { id: "choice-criteria", group: "research" },
  { id: "numbers-context", group: "research" },
  { id: "tailored-proposal", group: "customers" },
  { id: "customer-followup", group: "customers" },
  { id: "sales-questions", group: "customers" },
  { id: "order-history", group: "customers" },
  { id: "demo-guide", group: "customers" },
  { id: "shift-handover", group: "operations" },
  { id: "quality-checklist", group: "operations" },
  { id: "folder-plan", group: "operations" },
  { id: "delivery-plan", group: "operations" },
  { id: "decision-log", group: "operations" },
] as const

export const jobGroupName = (group: JobGroupId, locale: Locale = "pt-BR"): string =>
  t(`jobs.group.${group}`, {}, locale)

export const getJobTemplates = (locale: Locale = "pt-BR"): JobTemplate[] =>
  definitions.map(({ id, group }) => ({
    id,
    group,
    name: t(`jobs.${id}.name`, {}, locale),
    description: t(`jobs.${id}.description`, {}, locale),
    roleLine: t(`jobs.${id}.roleLine`, {}, locale),
    instructions: t(
      id === "team-builder" ? "job.teamBuilder" : "job.starter",
      {
        name: t(`jobs.${id}.name`, {}, locale),
        role: t(`jobs.${id}.roleLine`, {}, locale),
        task: t(`jobs.${id}.task`, {}, locale),
      },
      locale,
    ),
    starterPrompts: t(`jobs.${id}.prompts`, {}, locale).split("\n"),
    ...(["team-update", "shift-handover"].includes(id) ? { suggestedCron: "0 9 * * 1-5" } : {}),
    ...(id === "focused-week" ? { suggestedCron: "0 9 * * 1" } : {}),
  }))

export const getBotJobId = (bot: Pick<Bot, "roleLine" | "instructions">): string | undefined =>
  (["pt-BR", "en"] as const)
    .flatMap((locale) => getJobTemplates(locale))
    .find((job) => bot.roleLine === job.roleLine || bot.instructions === job.instructions)?.id

export const getComplementaryJobs = (bots: Bot[], locale: Locale = "pt-BR"): JobTemplate[] => {
  const jobs = getJobTemplates(locale)
  const coveredIds = bots.filter((bot) => !bot.archivedAt).map(getBotJobId)
  const coveredGroups = jobs.filter((job) => coveredIds.includes(job.id)).map((job) => job.group)
  const available = jobs.filter((job) => !coveredIds.includes(job.id))
  const related = available.filter((job) => coveredGroups.includes(job.group))
  const other = available.filter((job) => !coveredGroups.includes(job.group))

  return [...related, ...other].slice(0, 3)
}

/** Repository work requires an explicitly connected source, never assumed project context. */
export const needsRepository = (bot: Bot | null): boolean => {
  if (!bot) return false
  const sourceJobs = new Set(["repository-map", "critical-tests", "change-explainer", "dependency-plan"])
  for (const locale of ["pt-BR", "en"] as const)
    if (
      getJobTemplates(locale).some(
        (job) => sourceJobs.has(job.id) && (bot.roleLine === job.roleLine || bot.instructions === job.instructions),
      )
    )
      return true
  return /\b(repository|repositório|desenvolvedor|developer|programador|coder)\b/i.test(bot.roleLine ?? "")
}
