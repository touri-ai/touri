import { useId, useState } from "react"
import { type Locale, t } from "../../i18n"
import { getJobTemplates, JOB_GROUP_IDS, type JobTemplate, jobGroupName, NOT_SURE_JOB_ID } from "./catalog"
import "./jobs.css"

const searchable = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()

export const JobPicker = ({
  value,
  onChange,
  locale = "pt-BR",
}: {
  value: string
  onChange: (job: JobTemplate | null) => void
  locale?: Locale
}) => {
  const id = useId()
  const [query, setQuery] = useState("")
  const jobs = getJobTemplates(locale)
  const filtered = jobs.filter((job) =>
    searchable(`${job.name} ${job.description} ${jobGroupName(job.group, locale)}`).includes(searchable(query.trim())),
  )
  const options = [null, ...filtered]
  const option = (job: JobTemplate | null) => {
    const optionId = job?.id ?? NOT_SURE_JOB_ID
    return (
      <label key={optionId} className="job-option">
        <input
          type="radio"
          name={id}
          value={optionId}
          checked={value === optionId}
          aria-labelledby={`${id}-${optionId}-name`}
          aria-describedby={`${id}-${optionId}-description`}
          onChange={() => onChange(job)}
          onKeyDown={(event) => {
            const index = options.findIndex((item) => (item?.id ?? NOT_SURE_JOB_ID) === optionId)
            const direction = ["ArrowRight", "ArrowDown"].includes(event.key)
              ? 1
              : ["ArrowLeft", "ArrowUp"].includes(event.key)
                ? -1
                : 0
            if (!direction && event.key !== "Home" && event.key !== "End") return
            event.preventDefault()
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? options.length - 1
                  : (index + direction + options.length) % options.length
            const choice = options[next] ?? null
            onChange(choice)
            const radios = event.currentTarget
              .closest(".job-picker")
              ?.querySelectorAll<HTMLInputElement>('input[type="radio"]')
            radios?.[next]?.focus()
          }}
        />
        <span>
          <strong id={`${id}-${optionId}-name`}>{job?.name ?? t("Not sure yet", {}, locale)}</strong>
          <small id={`${id}-${optionId}-description`}>
            {job?.description ?? t("Choose a job later in the bot settings.", {}, locale)}
          </small>
        </span>
      </label>
    )
  }
  return (
    <fieldset className="job-picker">
      <legend>{t("What does it do?", {}, locale)}</legend>
      <input
        type="search"
        aria-label={t("Search jobs", {}, locale)}
        placeholder={t("Search jobs", {}, locale)}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.preventDefault()
        }}
      />
      <div className="job-options" role="radiogroup" aria-label={t("What does it do?", {}, locale)}>
        {option(null)}
        {JOB_GROUP_IDS.map((group) => {
          const matches = filtered.filter((job) => job.group === group)
          return matches.length > 0 ? (
            <div className="job-group" key={group}>
              <h4>{jobGroupName(group, locale)}</h4>
              <div className="job-grid">{matches.map(option)}</div>
            </div>
          ) : null
        })}
        {filtered.length === 0 && <p role="status">{t("No jobs found. Try another search.", {}, locale)}</p>}
      </div>
    </fieldset>
  )
}
