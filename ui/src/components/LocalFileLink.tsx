import type { WorkspaceFileContent } from "@touri/contracts"
import { type ReactNode, useContext, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ApiError } from "../errors"
import { t } from "../i18n"
import { useSaveNotice } from "../useSaveNotice"
import { EvidenceContext } from "./EvidenceGallery"
import { MarkdownContent } from "./MarkdownContent"
import "./local-file-links.css"

const FilePreview = ({ file, close }: { file: WorkspaceFileContent; close: () => void }) => {
  const dialog = useRef<HTMLDialogElement>(null)
  const { notice, saveBytes } = useSaveNotice()
  useEffect(() => {
    const element = dialog.current
    const origin = document.activeElement as HTMLElement | null
    element?.showModal()
    return () => {
      element?.close()
      origin?.focus()
    }
  }, [])
  const text =
    file.mime.startsWith("text/") ||
    /\.(md|markdown|json|csv|ts|tsx|js|jsx|py|rs|toml|ya?ml|log|sh|css)$/i.test(file.name)
  const content = text ? new TextDecoder().decode(Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0))) : ""
  return createPortal(
    <dialog ref={dialog} className="local-file-preview" aria-label={file.name} onCancel={close}>
      <header>
        <strong>{file.name}</strong>
        <button className="button button-quiet" type="button" onClick={() => void saveBytes(file)}>
          {t("Baixar arquivo")}
        </button>
        <button className="button button-quiet" type="button" onClick={close}>
          {t("Fechar arquivo")}
        </button>
      </header>
      {notice && <p role="status">{notice}</p>}
      {/^image\/(png|jpeg|gif|webp)$/.test(file.mime) ? (
        <img src={`data:${file.mime};base64,${file.base64}`} alt={file.name} />
      ) : text ? (
        /\.(md|markdown)$/i.test(file.name) ? (
          <MarkdownContent content={content} />
        ) : (
          <pre>{content}</pre>
        )
      ) : (
        <p>{t("Prévia indisponível para este formato. Baixe para abrir no seu computador.")}</p>
      )}
    </dialog>,
    document.body,
  )
}

export const LocalFileLink = ({ path, children }: { path: string; children: ReactNode }) => {
  const context = useContext(EvidenceContext)
  const [file, setFile] = useState<WorkspaceFileContent | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const generation = useRef(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different file or bot invalidates pending reads and previews
  useEffect(() => {
    generation.current += 1
    setFile(null)
    setBusy(false)
    setError("")
    return () => {
      generation.current += 1
    }
  }, [path, context?.api, context?.bot.id])
  const open = async () => {
    if (!context) return setError(t("Abra este arquivo na conversa do bot que o salvou."))
    const current = ++generation.current
    setBusy(true)
    setError("")
    try {
      const content = await context.api.request("GET /bots/:id/files/content", { path }, { id: context.bot.id })
      if (current === generation.current) setFile(content)
    } catch (reason) {
      if (current === generation.current)
        setError(
          reason instanceof ApiError && reason.errorCode === "IMAGE_MACHINE_STOPPED"
            ? t("Arquivos disponíveis quando a máquina estiver ligada.")
            : reason instanceof ApiError && reason.status === 403
              ? t("Este arquivo está fora das pastas permitidas para este bot.")
              : t(
                  "Não foi possível abrir este arquivo. Ele pode ter sido removido, ser um atalho ou ter mais de 512 KB.",
                ),
        )
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }
  return (
    <span>
      <button className="local-file-link" type="button" onClick={() => void open()} disabled={busy} aria-busy={busy}>
        {children}
      </button>
      {error && (
        <span className="local-file-error" role="alert">
          {" "}
          {error}
        </span>
      )}
      {file && <FilePreview file={file} close={() => setFile(null)} />}
    </span>
  )
}
