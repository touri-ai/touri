import type { FilePart, ImagePart } from "@touri/contracts"
import { useState } from "react"
import type { UiApi } from "../api/client"
import { t } from "../i18n"
import { useSaveNotice } from "../useSaveNotice"
import "./message-actions.css"

export const MessageAttachments = ({ parts, api }: { parts: Array<FilePart | ImagePart>; api?: UiApi | undefined }) => {
  const [downloading, setDownloading] = useState<string | null>(null)
  const { notice, saveImage } = useSaveNotice()
  if (!parts.length) return null
  return (
    <div className="message-attachments">
      <ul aria-label={t("Arquivos enviados")}>
        {[...new Map(parts.map((part) => [part.attachmentId, part])).values()].map((part) => {
          const name = part.name || t("Imagem anexada")
          return (
            <li key={part.attachmentId}>
              <span>{name}</span>
              <button
                type="button"
                className="text-button"
                aria-label={t("Baixar {name}", { name })}
                disabled={!api || downloading !== null}
                onClick={async () => {
                  if (!api || downloading !== null) return
                  setDownloading(part.attachmentId)
                  try {
                    await saveImage(() => api.request("GET /attachments/:id", {}, { id: part.attachmentId }), name)
                  } finally {
                    setDownloading(null)
                  }
                }}
              >
                {downloading === part.attachmentId ? t("Baixando…") : t("Baixar")}
              </button>
            </li>
          )
        })}
      </ul>
      {notice && <p role="status">{notice}</p>}
    </div>
  )
}
