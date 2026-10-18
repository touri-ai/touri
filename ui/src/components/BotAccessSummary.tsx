import type { Bot, HostKind } from "@touri/contracts"
import { useIsServerMode } from "../features/server/serverMode"
import { accessLabel, getHostLabel, t } from "../i18n"

export const BotAccessSummary = ({
  machine,
  access,
  approvals,
  anyFolderAccess = false,
  folders = [],
  host = "computer",
}: Pick<Bot, "machine" | "access" | "approvals" | "anyFolderAccess" | "folders"> & { host?: HostKind }) => {
  const serverMode = useIsServerMode()
  const boundary = getAccessBoundary({ machine, access, anyFolderAccess, folders }, host, serverMode)

  return (
    <p className="field-help">{t("{access}; {boundary}", { access: accessLabel({ access, approvals }), boundary })}</p>
  )
}

const getAccessBoundary = (
  { machine, access, anyFolderAccess, folders = [] }: Pick<Bot, "machine" | "access" | "anyFolderAccess" | "folders">,
  host: HostKind,
  serverMode: boolean,
) => {
  if (machine === "cloud") return t("só na máquina na nuvem.")
  if (machine === "vm")
    return anyFolderAccess || folders.length
      ? t("só no computador isolado e nas pastas compartilhadas.")
      : t("só no computador isolado.")
  if (serverMode) return t("trabalha no servidor escolhido; não pode acessar os arquivos deste aparelho.")

  const hostLabel = getHostLabel(host)
  if (access === "read-only") return t("can read files on this {host} without changing them.", { host: hostLabel })
  if (access === "full") return t("pode ler e alterar arquivos em qualquer pasta que a conta do sistema permita.")
  if (anyFolderAccess)
    return t("can access files across this {host}; sensitive folder exclusions still apply.", { host: hostLabel })

  return t("alterações ficam na pasta do bot, no projeto e nas pastas liberadas.")
}
