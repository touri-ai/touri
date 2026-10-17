import type { Bot } from "@touri/contracts"
import { useContext } from "react"
import { FailureActionContext } from "../../components/FailureActionContext"
import { t } from "../../i18n"

export const VmCapabilityNotice = ({ bot }: { bot: Bot }) => {
  const openSetting = useContext(FailureActionContext)
  if (bot.machine !== "vm") return null
  return (
    <>
      {bot.browserEnabled === false && (
        <p className="desktop-observe-note" role="status">
          {t("O navegador deste bot está desativado.")}{" "}
          <button
            type="button"
            className="button button-quiet"
            onClick={() => openSetting({ kind: "setting", settingId: "browserEnabled", label: t("Ativar navegador") })}
          >
            {t("Ativar navegador")}
          </button>
        </p>
      )}
      {bot.computerUse === false && (
        <p className="desktop-observe-note" role="status">
          {t("O controle automático do computador está desativado. Você ainda pode assumir o controle manualmente.")}{" "}
          <button
            type="button"
            className="button button-quiet"
            onClick={() => openSetting({ kind: "setting", settingId: "computerUse", label: t("Configurar controle") })}
          >
            {t("Configurar controle")}
          </button>
        </p>
      )}
    </>
  )
}
