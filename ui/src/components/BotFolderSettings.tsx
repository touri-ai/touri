import type { Bot, BotFolder } from "@touri/contracts"
import { useRef, useState } from "react"
import type { TauriInvoke } from "../api/client"
import { userFacingError } from "../errors"
import { t } from "../i18n"
import { Modal } from "./Modals"
import { SettingsSwitch } from "./SettingsLayout"

export const BotFolderSettings = ({
  folders,
  anyFolderAccess,
  machine,
  disabled,
  invokeCommand,
  onFolders,
  onAnyFolderAccess,
}: {
  folders: BotFolder[]
  anyFolderAccess: boolean
  machine: Bot["machine"]
  disabled: boolean
  invokeCommand?: TauriInvoke | undefined
  onFolders: (folders: BotFolder[]) => void
  onAnyFolderAccess: (enabled: boolean) => void
}) => {
  const [confirming, setConfirming] = useState(false)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pickingRef = useRef(false)
  const chooseFolder = async () => {
    if (!invokeCommand || pickingRef.current || disabled) return
    pickingRef.current = true
    setPicking(true)
    setError(null)
    try {
      const result = await invokeCommand("pick_folder", { title: t("Adicionar pasta acessível ao bot") })
      if (result?.path && !folders.some((folder) => folder.path === result.path))
        onFolders([...folders, { path: result.path, access: "read-only" }])
    } catch (error) {
      setError(userFacingError(error))
    } finally {
      pickingRef.current = false
      setPicking(false)
    }
  }
  return (
    <div className="bot-folder-settings">
      <strong>{t("Pastas que este bot pode acessar")}</strong>
      {!folders.length && <p className="field-help">{t("Nenhuma pasta adicional.")}</p>}
      <ul className="bot-folder-list">
        {folders.map((folder, index) => (
          <li key={folder.path}>
            <span className="bot-folder-path">{folder.path}</span>
            <select
              aria-label={t("Acesso à pasta {path}", { path: folder.path })}
              disabled={disabled || picking}
              value={folder.access}
              onChange={(event) =>
                onFolders(
                  folders.map((item, i) =>
                    i === index ? { ...item, access: event.target.value as BotFolder["access"] } : item,
                  ),
                )
              }
            >
              <option value="read-only">{t("Somente leitura")}</option>
              <option value="read-write">{t("Leitura e escrita")}</option>
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
        disabled={disabled || picking || !invokeCommand || folders.length >= 32}
        onClick={() => void chooseFolder()}
      >
        {t("Adicionar pasta…")}
      </button>
      {error && <p role="alert">{error}</p>}
      <label className="toggle-row" htmlFor="settings-any-folder">
        <span>
          <strong>{t("Acesso a qualquer pasta deste Mac")}</strong>
          <small>{t("O nível de acesso e as aprovações continuam valendo.")}</small>
        </span>
        <SettingsSwitch
          id="settings-any-folder"
          checked={anyFolderAccess}
          disabled={disabled || picking}
          onChange={(event) => (event.target.checked ? setConfirming(true) : onAnyFolderAccess(false))}
        />
      </label>
      <p className="field-help">
        {t(
          "Keychains, ~/.ssh, perfis de navegadores e dados do touri ficam bloqueados, salvo pastas adicionadas explicitamente. Os arquivos necessários ao funcionamento deste bot continuam disponíveis.",
        )}
      </p>
      <p className="field-help">
        {machine === "vm"
          ? t(
              "Na VM, sua pasta pessoal aparece em /host/home; as demais, em /host/<nome>. As exclusões são ocultadas por montagens somente leitura.",
            )
          : t(
              "No Mac, o sandbox do macOS bloqueia as exclusões e a escrita nas pastas somente leitura, inclusive em comandos de terminal. As alterações valem no próximo turno.",
            )}
      </p>
      {machine === "vm" && (
        <p className="settings-inline-note">
          {t(
            "Ao salvar, as pastas serão aplicadas com a recriação da máquina no próximo turno. Os arquivos da máquina serão preservados.",
          )}
        </p>
      )}
      {confirming && (
        <Modal title={t("Permitir acesso a qualquer pasta?")} onClose={() => setConfirming(false)}>
          <p>
            {t(
              "Este bot poderá ler arquivos pessoais de todo o Mac e, conforme o nível de acesso, alterá-los ou apagá-los. Na VM, sua pasta pessoal será montada em /host/home. Conceda este acesso apenas a bots em que confia.",
            )}
          </p>
          <p>{t("As exclusões de pastas sensíveis, o nível de acesso e as aprovações continuam valendo.")}</p>
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
