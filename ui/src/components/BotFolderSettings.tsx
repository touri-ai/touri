import type { Bot, BotFolder, HostKind } from "@touri/contracts"
import { useEffect, useState } from "react"
import type { TauriInvoke, UiApi } from "../api/client"
import { useIsServerMode } from "../features/server/serverMode"
import { getHostLabel, t } from "../i18n"
import { useHost } from "../useHost"
import { FolderPicker } from "./FolderPicker"
import { Modal } from "./Modal"
import { SettingsSwitch } from "./SettingsLayout"

export const BotFolderSettings = ({
  api,
  simple = false,
  fullAccess = false,
  folders,
  anyFolderAccess,
  machine,
  disabled,
  invokeCommand,
  onFolders,
  onAnyFolderAccess,
  onUpload,
}: {
  onUpload?: (() => void) | undefined
  api?: UiApi | undefined
  simple?: boolean
  readOnly?: boolean
  fullAccess?: boolean
  folders: BotFolder[]
  anyFolderAccess: boolean
  machine: Bot["machine"]
  disabled: boolean
  invokeCommand?: TauriInvoke | undefined
  onFolders: (folders: BotFolder[]) => void
  onAnyFolderAccess: (enabled: boolean) => void
}) => {
  const host = useHost(api)
  const serverMode = useIsServerMode() || host === "server"
  const [confirming, setConfirming] = useState(false)
  const [picking, setPicking] = useState(false)
  const unrestricted = machine === "local" && fullAccess
  const [available, setAvailable] = useState<boolean | null>(null)
  useEffect(() => {
    let current = true
    if (api && machine === "local")
      void api
        .request("GET /folders", {})
        .then((listing) => {
          if (current) setAvailable(listing.canGrant)
        })
        .catch(() => {
          if (current) setAvailable(false)
        })
    return () => {
      current = false
    }
  }, [api, machine])
  return (
    <div className="bot-folder-settings">
      <strong>
        {unrestricted ? t("Pastas salvas para modos de acesso restrito") : t("Pastas que este bot pode acessar")}
      </strong>
      {serverMode && (
        <p className="field-help">
          {t("As pastas abaixo pertencem ao servidor. Pastas deste aparelho não são compartilhadas.")}
        </p>
      )}
      {unrestricted && (
        <p className="field-help">
          {t("Estas opções ficam salvas para modos de acesso restrito. Elas não limitam o acesso total atual.")}
        </p>
      )}
      {!unrestricted && available === false && !folders.length && !anyFolderAccess && (
        <p role="status">
          {t(
            "Este computador não consegue proteger o acesso a pastas. Nenhuma permissão foi adicionada. Você pode continuar conversando ou enviar um arquivo.",
          )}
        </p>
      )}
      {!unrestricted && available === false && (folders.length > 0 || anyFolderAccess) && (
        <div role="status">
          <p>
            {t(
              "As permissões de pastas salvas não funcionam neste computador. Você pode conversar sem ferramentas. Remova essas permissões nas configurações do bot para continuar com tarefas.",
            )}
          </p>
          <button
            type="button"
            className="button-quiet"
            disabled={disabled || picking}
            onClick={() => {
              onFolders([])
              onAnyFolderAccess(false)
            }}
          >
            {t("Remover permissões antigas")}
          </button>
        </div>
      )}
      {!folders.length && <p className="field-help">{t("Nenhuma pasta adicional.")}</p>}
      <ul className="bot-folder-list">
        {folders.map((folder, index) => (
          <li key={folder.path}>
            <span className="bot-folder-path">{folder.path}</span>
            <select
              aria-label={t("Acesso à pasta {path}", { path: folder.path })}
              disabled={disabled || picking || available === false}
              value={folder.access}
              onChange={(event) =>
                onFolders(
                  folders.map((item, i) =>
                    i === index ? { ...item, access: event.target.value as BotFolder["access"] } : item,
                  ),
                )
              }
            >
              <option value="read-only">{t("O bot pode ler")}</option>
              <option value="read-write">{t("O bot pode ler e salvar arquivos aqui")}</option>
            </select>
            <button
              type="button"
              className="button-quiet"
              disabled={disabled || picking}
              aria-label={t("Remover pasta {path}", { path: folder.path })}
              onClick={() => onFolders(folders.filter((_, i) => i !== index))}
            >
              {t("Remover")}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="button-quiet"
        disabled={disabled || picking || !api || folders.length >= 32}
        onClick={() => setPicking(true)}
      >
        {simple ? t("Usar uma pasta") : t("Adicionar pasta…")}
      </button>
      {picking && api && (
        <FolderPicker
          api={api}
          invokeCommand={invokeCommand}
          initialAccess="read-only"
          requireAccess
          onUpload={onUpload}
          onClose={() => setPicking(false)}
          onSelect={(folder) => {
            setAvailable(true)
            if (!folders.some((item) => item.path === folder.path)) onFolders([...folders, folder])
            setPicking(false)
          }}
        />
      )}
      {!simple && (
        <>
          <label className="toggle-row" htmlFor="settings-any-folder">
            <span>
              <strong>
                {unrestricted
                  ? t("Acesso a qualquer pasta no modo restrito")
                  : t("Access to any folder on this {host}", { host: getHostLabel(host) })}
              </strong>
              <small>
                {unrestricted
                  ? t("Esta opção só vale quando o acesso é restrito.")
                  : t("O nível de acesso e as aprovações continuam valendo.")}
              </small>
            </span>
            <SettingsSwitch
              id="settings-any-folder"
              checked={anyFolderAccess}
              disabled={disabled || picking || (available === false && !anyFolderAccess)}
              onChange={(event) => (event.target.checked ? setConfirming(true) : onAnyFolderAccess(false))}
            />
          </label>
          {unrestricted ? (
            <p className="field-help">{t("As permissões da conta do sistema continuam valendo.")}</p>
          ) : (
            <>
              <p className="field-help">
                {t(
                  "Keychains, ~/.ssh, perfis de navegadores e dados do touri ficam bloqueados, salvo pastas adicionadas explicitamente. Os arquivos necessários ao funcionamento deste bot continuam disponíveis.",
                )}
              </p>
              <p className="field-help">{getFolderIsolationHelp(machine, host, serverMode)}</p>
            </>
          )}
          {machine === "vm" && (
            <p className="settings-inline-note">
              {t(
                "Ao salvar, as pastas valerão a partir da próxima mensagem, quando a máquina será recriada. Os arquivos da máquina serão preservados.",
              )}
            </p>
          )}
        </>
      )}
      {confirming && (
        <Modal title={t("Permitir acesso a qualquer pasta?")} onClose={() => setConfirming(false)}>
          <p>
            {unrestricted
              ? t("Esta opção fica salva para modos de acesso restrito. O acesso total atual não muda.")
              : serverMode
                ? t(
                    "Este bot poderá ler arquivos de todo o servidor e, conforme o nível de acesso, alterá-los ou apagá-los. Conceda este acesso apenas a bots em que confia.",
                  )
                : t(
                    "Este bot poderá ler arquivos pessoais de todo o computador e, conforme o nível de acesso, alterá-los ou apagá-los. Na VM, sua pasta pessoal será montada em /host/home. Conceda este acesso apenas a bots em que confia.",
                  )}
          </p>
          {!unrestricted && (
            <p>{t("As exclusões de pastas sensíveis, o nível de acesso e as aprovações continuam valendo.")}</p>
          )}
          <div className="modal-actions">
            <button type="button" className="button-quiet" data-initial-focus onClick={() => setConfirming(false)}>
              {t("Cancelar")}
            </button>
            <button
              type="button"
              className="button button-brand"
              onClick={() => {
                onAnyFolderAccess(true)
                setConfirming(false)
              }}
            >
              {t("Permitir acesso")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

const getFolderIsolationHelp = (machine: Bot["machine"], host: HostKind, serverMode: boolean) => {
  if (machine === "vm")
    return t(
      "Na VM, sua pasta pessoal aparece em /host/home; as demais, em /host/<nome>. As exclusões são ocultadas por montagens somente leitura.",
    )
  if (serverMode) return t("As permissões e o isolamento são aplicados pelo servidor. Revise o acesso antes de salvar.")
  if (host === "mac")
    return t(
      "No Mac, o sandbox do macOS bloqueia as exclusões e a escrita nas pastas somente leitura, inclusive em comandos de terminal. As alterações valem a partir da próxima mensagem.",
    )

  return t("As permissões da conta do sistema continuam valendo.")
}
