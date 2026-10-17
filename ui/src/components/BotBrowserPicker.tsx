import type { Bot, BotBrowser } from "@touri/contracts"
import { useId, useState } from "react"
import { t } from "../i18n"
import { useIsServerMode } from "../features/server/serverMode"

const EXPLAINED_KEY = "touri.local-chrome.explained"
const wasExplained = (): boolean => {
  try {
    return localStorage.getItem(EXPLAINED_KEY) === "1"
  } catch {
    return false
  }
}

export const BotBrowserPicker = ({
  value,
  machine,
  disabled = false,
  onChange,
}: {
  value: BotBrowser
  machine: Bot["machine"]
  disabled?: boolean
  onChange: (browser: BotBrowser) => void
}) => {
  const serverMode = useIsServerMode()
  const id = useId()
  const [explained, setExplained] = useState(wasExplained)
  return (
    <div className="settings-fields">
      <label htmlFor={id}>{t("Bot browser")}</label>
      <select
        id={id}
        value={value}
        disabled={disabled || machine === "cloud"}
        aria-describedby={`${id}-help`}
        onChange={(event) => onChange(event.target.value as BotBrowser)}
      >
        <option value="touri" disabled={machine === "vm"}>
          {t("touri Chrome")}
        </option>
        <option value="local" disabled={serverMode || machine !== "local"}>
          {t("My Chrome")}
        </option>
        <option value="machine" disabled={machine !== "vm"}>
          {t("Machine Chrome")}
        </option>
      </select>
      <p id={`${id}-help`} className="field-help">
        {serverMode
          ? t(
              "Seu navegador pessoal fica indisponível no modo servidor. Use o navegador do servidor ou do computador isolado.",
            )
          : machine === "local"
            ? t("Machine Chrome requires a bot on the Linux machine.")
            : t("My Chrome is available only for bots on this Mac. A remote machine cannot reach your Mac's Chrome.")}
      </p>
      {!serverMode && value === "local" && machine === "local" && (
        <>
          {!explained && (
            <div className="warning-callout" role="note">
              <p>
                {t(
                  "The bot will act inside your signed-in sessions in a separate Chrome window. You can close that window or press Stop at any time.",
                )}
              </p>
              <button
                type="button"
                className="button button-quiet"
                onClick={() => {
                  setExplained(true)
                  try {
                    localStorage.setItem(EXPLAINED_KEY, "1")
                  } catch {}
                }}
              >
                {t("Got it")}
              </button>
            </div>
          )}
          <ol className="field-help">
            <li>
              {t("In Google Chrome, open")} <code>chrome://inspect/#remote-debugging</code>.
            </li>
            <li>{t("Allow remote debugging.")}</li>
            <li>{t("Accept Chrome's permission prompt when the bot connects.")}</li>
          </ol>
        </>
      )}
    </div>
  )
}
