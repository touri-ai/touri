import type { ApiRoutes } from "@touri/contracts"
import { useId, useState } from "react"
import type { UiApi } from "../../api/client"
import { ErrorText } from "../../components/ErrorDetails"
import { userFacingError } from "../../errors"
import { t } from "../../i18n"

type GrantResponse = ApiRoutes["POST /computer/grants"]["res"]

export type ComputerGrantCardProps = {
  api: UiApi
  botId: string
  threadId: string
  botName?: string
  defaultMinutes?: number
  onGranted?: (grant: GrantResponse) => void
}

export const ComputerGrantCard = ({
  api,
  botId,
  threadId,
  botName = t("This bot"),
  defaultMinutes = 30,
  onGranted,
}: ComputerGrantCardProps) => {
  const minutesId = useId()
  const [minutes, setMinutes] = useState(defaultMinutes)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const grant = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await api.request("POST /computer/grants", { botId, threadId, minutes })
      onGranted?.(result)
      setMessage(t("Granted until", { time: new Date(result.expiresAt).toLocaleTimeString("pt-BR") }))
    } catch (caught) {
      setMessage(caught instanceof Error ? userFacingError(caught) : t("Could not grant computer use"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="rounded-2xl border border-brand/30 bg-red-50 p-4 dark:bg-red-950/20">
      <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-brand">{t("Approval needed")}</p>
      <p className="mt-2 text-sm leading-6 text-stone-700 dark:text-stone-200">
        {t("Computer permission waiting", { name: botName })}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="font-mono text-xs text-stone-600 dark:text-stone-300" htmlFor={minutesId}>
          {t("For")}
        </label>
        <select
          className="rounded-lg border border-stone-300 bg-white px-2 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
          id={minutesId}
          onChange={(event) => setMinutes(Number(event.target.value))}
          value={minutes}
        >
          {[5, 15, 30, 60, 120].map((value) => (
            <option key={value} value={value}>
              {t("Minutes", { count: value })}
            </option>
          ))}
        </select>
        <button
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-wait disabled:opacity-50"
          disabled={busy}
          onClick={() => void grant()}
          type="button"
        >
          {busy ? t("Granting…") : t("Allow computer use")}
        </button>
      </div>
      {message ? (
        <div className="mt-3 font-mono text-xs text-stone-600 dark:text-stone-300">
          <ErrorText text={message} />
        </div>
      ) : null}
    </aside>
  )
}
