import type { FilePart, ImagePart } from "@touri/contracts"
import { useMemo, useState } from "react"
import type { UiApi } from "../api/client"
import { t } from "../i18n"
import { useSaveNotice } from "../useSaveNotice"
import { EvidenceGallery } from "./EvidenceGallery"
import type { EvidenceImage } from "./evidenceMarkdown"
import "./message-actions.css"

export const MessageAttachments = ({ parts, api }: { parts: Array<FilePart | ImagePart>; api?: UiApi | undefined }) => {
  const [downloading, setDownloading] = useState<string | null>(null)
  const { notice, saveImage } = useSaveNotice()
  const unique = useMemo(() => Array.from(new Map(parts.map((part) => [part.attachmentId, part])).values()), [parts])
  const images = useMemo(
    (): EvidenceImage[] =>
      !api
        ? []
        : unique
            .filter((part) => /^image\/(png|jpeg|webp|gif)$/.test(part.mime))
            .slice(0, 12)
            .map((part) => ({
              path: `/attachments/${part.attachmentId}`,
              filename: part.name || t("Imagem anexada"),
              caption: part.name || t("Imagem anexada"),
              cacheKey: api,
              read: () => api.request("GET /attachments/:id", {}, { id: part.attachmentId }),
            })),
    [unique, api],
  )
  const files = unique.filter((part) => !images.some((image) => image.path === `/attachments/${part.attachmentId}`))
  if (!parts.length) return null
  return (
    <div className="message-attachments">
      {images.length > 0 && <EvidenceGallery images={images} />}
      {files.length > 0 && (
        <ul aria-label={t("Arquivos enviados")}>
          {files.map((part) => {
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
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  )
}
