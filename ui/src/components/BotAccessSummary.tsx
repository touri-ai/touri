import type { Bot } from "@touri/contracts"
import { useIsServerMode } from "../features/server/serverMode"
import { accessLabel, t } from "../i18n"

export const BotAccessSummary = ({
  machine,
  access,
  approvals,
  anyFolderAccess,
  folders = [],
}: Pick<Bot, "machine" | "access" | "approvals" | "anyFolderAccess" | "folders">) => {
  const serverMode = useIsServerMode()
  const boundary =
    machine === "cloud"
      ? t("só na máquina na nuvem.")
      : machine === "vm"
        ? anyFolderAccess || folders.length
          ? t("só no computador isolado e nas pastas compartilhadas.")
          : t("só no computador isolado.")
        : serverMode
          ? t("trabalha no servidor escolhido; não pode acessar os arquivos deste Mac.")
          : access === "read-only"
            ? t("pode ler arquivos no Mac, sem alterá-los.")
            : access === "full"
              ? t("pode ler e alterar arquivos em qualquer pasta que a conta do sistema permita.")
              : anyFolderAccess
                ? t("pode acessar arquivos em todo o Mac; as exclusões de pastas sensíveis continuam valendo.")
                : t("alterações ficam na pasta do bot, no projeto e nas pastas liberadas.")
  return (
    <p className="field-help">{t("{access}; {boundary}", { access: accessLabel({ access, approvals }), boundary })}</p>
  )
}
