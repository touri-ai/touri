import type { Bot } from "@touri/contracts"
import { t } from "../i18n"

export const BotAccessSummary = ({
  machine,
  access,
  approvals,
  anyFolderAccess,
  folders = [],
}: Pick<Bot, "machine" | "access" | "approvals" | "anyFolderAccess" | "folders">) => {
  const summary =
    machine === "cloud"
      ? t("Só a máquina na nuvem")
      : machine === "vm"
        ? anyFolderAccess || folders.length
          ? t("Só a VM isolada e as pastas compartilhadas")
          : t("Só a VM isolada")
        : access === "read-only"
          ? t("Pode ler arquivos do Mac; sem permissão de escrita")
          : approvals === "on-request"
            ? t("Pode acessar pastas do Mac com aprovação; escrita nas pastas permitidas")
            : anyFolderAccess
              ? t("Pode acessar todo o Mac")
              : t("Pode ler arquivos do Mac; escrita na pasta do bot, no projeto e nas pastas permitidas")
  return (
    <p className="field-help">
      {summary}
      {machine !== "local" && access === "read-only" ? ` · ${t("Somente leitura")}` : ""}
    </p>
  )
}
