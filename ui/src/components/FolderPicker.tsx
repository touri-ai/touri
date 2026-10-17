import type { BotFolder, FolderListing } from "@touri/contracts"
import { useCallback, useEffect, useRef, useState } from "react"
import type { TauriInvoke, UiApi } from "../api/client"
import { userFacingError } from "../errors"
import { t } from "../i18n"
import { Modal } from "./Modal"
import "./folder-picker.css"

export const FolderPicker = ({
  api,
  invokeCommand,
  initialAccess = "read-only",
  onSelect,
  onClose,
}: {
  api: UiApi
  invokeCommand?: TauriInvoke | undefined
  initialAccess?: BotFolder["access"]
  onSelect: (folder: BotFolder) => void | Promise<void>
  onClose: () => void
}) => {
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [typedPath, setTypedPath] = useState("")
  const [access, setAccess] = useState(initialAccess)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [confirming, setConfirming] = useState(false)
  const generation = useRef(0)
  const busyRef = useRef(false)
  const load = useCallback(
    async (path?: string) => {
      const request = ++generation.current
      setBusy(true)
      setListing(null)
      setError(null)
      try {
        const result = await api.request("GET /folders", path ? { path } : {})
        if (request !== generation.current) return
        setListing(result)
        setTypedPath(result.path)
        setCreating(false)
        setConfirming(false)
      } catch (error) {
        if (request === generation.current) setError(userFacingError(error))
      } finally {
        if (request === generation.current) setBusy(false)
      }
    },
    [api],
  )
  useEffect(() => {
    void load()
    return () => {
      generation.current++
    }
  }, [load])
  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (error) {
      setError(userFacingError(error))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  const crumbs = listing
    ? [
        { name: "/", path: "/" },
        ...listing.path
          .split("/")
          .filter(Boolean)
          .map((name, index, parts) => ({
            name,
            path: `/${parts.slice(0, index + 1).join("/")}`,
          })),
      ]
    : []
  return (
    <Modal title={t("Escolher pasta")} className="folder-picker" onClose={() => !busyRef.current && onClose()}>
      <div className="folder-picker-body">
        <p className="field-help">{t("As pastas estão no computador onde o touri está rodando.")}</p>
        <nav aria-label={t("Caminho da pasta")} className="folder-picker-breadcrumbs">
          <button type="button" className="button-quiet" disabled={busy} onClick={() => void load()}>
            {t("Pasta pessoal")}
          </button>
          {crumbs.map((crumb) => (
            <button
              type="button"
              className="button-quiet"
              key={crumb.path}
              aria-current={crumb.path === listing?.path ? "location" : undefined}
              disabled={busy}
              onClick={() => void load(crumb.path)}
            >
              {crumb.name}
            </button>
          ))}
        </nav>
        <div className="folder-picker-list" aria-busy={busy}>
          {busy && <p role="status">{t("Carregando pastas…")}</p>}
          {listing?.parent && (
            <button
              type="button"
              className="button-quiet"
              disabled={busy}
              onClick={() => void load(listing.parent ?? undefined)}
            >
              {t("Voltar uma pasta")}
            </button>
          )}
          {!busy && listing && !listing.folders.length && <p>{t("Nenhuma subpasta aqui.")}</p>}
          <ul aria-label={t("Pastas")}>
            {listing?.folders.map((folder) => (
              <li key={folder.path}>
                <button type="button" className="button-quiet" disabled={busy} onClick={() => void load(folder.path)}>
                  <span aria-hidden="true">▸ </span>
                  {folder.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
        {listing?.truncated && (
          <p role="status">{t("Há mais pastas. Use Digitar caminho para abrir uma que não aparece.")}</p>
        )}
        <details>
          <summary>{t("Digitar caminho")}</summary>
          <label htmlFor="folder-picker-path">{t("Caminho absoluto da pasta")}</label>
          <div className="input-with-button">
            <input
              id="folder-picker-path"
              value={typedPath}
              disabled={busy}
              onChange={(event) => setTypedPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  event.stopPropagation()
                  if (!busy && typedPath.trim()) void load(typedPath.trim())
                }
              }}
            />
            <button
              type="button"
              className="button-quiet"
              disabled={busy || !typedPath.trim()}
              onClick={() => void load(typedPath.trim())}
            >
              {t("Abrir pasta")}
            </button>
          </div>
        </details>
        {invokeCommand && "__TAURI_INTERNALS__" in window && (
          <button
            type="button"
            className="button-quiet"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const selected = await invokeCommand("pick_folder", { title: t("Escolher pasta") })
                if (selected?.path) await load(selected.path)
              })
            }
          >
            {t("Escolher no Mac…")}
          </button>
        )}
        <button
          type="button"
          className="button-quiet"
          disabled={busy || !listing}
          onClick={() => {
            setCreating(true)
            setName("")
            setError(null)
          }}
        >
          {t("Nova pasta")}
        </button>
        {creating && (
          <div className="folder-picker-create">
            <label htmlFor="folder-picker-name">{t("Nome da nova pasta")}</label>
            <input
              id="folder-picker-name"
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault()
              }}
            />
            <button
              type="button"
              className="button-quiet"
              disabled={busy || !name.trim()}
              onClick={() => setConfirming(true)}
            >
              {t("Continue")}
            </button>
            {confirming && (
              <div role="alertdialog" aria-label={t("Criar pasta?")}>
                <p>{t("Criar a pasta {name} dentro de {path}?", { name: name.trim(), path: listing?.path ?? "" })}</p>
                <button type="button" className="button-quiet" disabled={busy} onClick={() => setConfirming(false)}>
                  {t("Cancelar")}
                </button>
                <button
                  type="button"
                  className="button button-brand"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      if (!listing) return
                      const created = await api.request("POST /folders", { path: listing.path, name: name.trim() })
                      await load(created.path)
                    })
                  }
                >
                  {t("Criar pasta")}
                </button>
              </div>
            )}
          </div>
        )}
        <fieldset className="folder-picker-access" disabled={busy}>
          <legend>{t("Acesso à pasta")}</legend>
          <label>
            <input
              type="radio"
              name="folder-access"
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault()
              }}
              checked={access === "read-only"}
              onChange={() => setAccess("read-only")}
            />
            {t("O bot pode ler")}
          </label>
          <label>
            <input
              type="radio"
              name="folder-access"
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault()
              }}
              checked={access === "read-write"}
              onChange={() => setAccess("read-write")}
            />
            {t("O bot pode ler e salvar arquivos aqui")}
          </label>
        </fieldset>
        <p className="field-help">{t("O nível de acesso e as aprovações continuam valendo.")}</p>
        {listing && <p className="bot-folder-path">{listing.path}</p>}
        {error && <p role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="button-quiet" disabled={busyRef.current} onClick={onClose}>
            {t("Cancelar")}
          </button>
          <button
            type="button"
            className="button button-brand"
            disabled={busy || !listing || confirming}
            onClick={() =>
              void run(async () => {
                if (listing) await onSelect({ path: listing.path, access })
              })
            }
          >
            {t("Usar esta pasta")}
          </button>
        </div>
      </div>
    </Modal>
  )
}
