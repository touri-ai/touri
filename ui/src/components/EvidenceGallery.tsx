import type { Bot } from "@touri/contracts"
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createTauriInvoke, type UiApi } from "../api/client"
import { ApiError } from "../errors"
import { t } from "../i18n"
import { useSaveNotice } from "../useSaveNotice"
import type { EvidenceImage } from "./evidenceMarkdown"
import { getCachedThumbnail, imageDimensions, loadImage, thumbnailBlob } from "./imageLoads"
import "./evidence-images.css"
import { blobDataUrl } from "../blobDataUrl"

export type EvidenceContextValue = {
  api: UiApi
  bot: Bot
  base?: string
  imageAttachments?: Array<{ path: string; attachmentId: string }>
  imageVersion?: string
  onLayoutChange?: () => void
  onLibrary?: ((path: string, botId?: string) => void) | undefined
  onComputer?: ((botId?: string) => void) | undefined
}
export const EvidenceContext = createContext<EvidenceContextValue | null>(null)
const INLINE_IMAGE = /^data:([^;,]*);base64,(.*)$/s
const inlineImage = (src: string): Blob | null => {
  const match = INLINE_IMAGE.exec(src)
  if (!match) return null
  const bytes = Uint8Array.from(atob(match[2] ?? ""), (c) => c.charCodeAt(0))
  return new Blob([bytes], { type: match[1] || "image/png" })
}
export const readImage = async (image: EvidenceImage, context: EvidenceContextValue | null): Promise<Blob> => {
  if (image.read) return image.read()
  if (image.src) return inlineImage(image.src) ?? (await fetch(image.src)).blob()
  if (!context) throw new Error("Imagem indisponível")
  const attachmentId =
    context.imageAttachments?.find((reference) => reference.path === image.path)?.attachmentId ??
    /^\/(?:api\/v1\/)?attachments\/([a-f0-9]{64})$/i.exec(image.path)?.[1]
  return context.api.request(
    "GET /bots/:id/images",
    attachmentId ? { attachmentId } : { path: image.path, ...(context.base ? { base: context.base } : {}) },
    { id: context.bot.id },
  )
}
export const getImageError = (error: unknown): string => {
  const code = error instanceof ApiError ? error.errorCode : ""
  if (code === "IMAGE_OUTSIDE_WORKSPACE" || (error instanceof ApiError && error.status === 403))
    return t("Imagem fora da pasta do bot")
  if (code === "IMAGE_NOT_FOUND" || (error instanceof ApiError && error.status === 404))
    return t("Imagem não encontrada")
  if (code === "IMAGE_TOO_LARGE") return t("Imagem acima de 15 MB")
  if (code === "IMAGE_UNSUPPORTED") return t("Formato de imagem não suportado")
  if (code === "IMAGE_MACHINE_STOPPED") return t("Imagem disponível quando a máquina estiver ligada")
  return t("Não foi possível carregar a imagem. Verifique a conexão.")
}
const canRetryImage = (error: unknown) =>
  !(error instanceof ApiError) ||
  error.status === 0 ||
  error.status >= 500 ||
  error.errorCode === "IMAGE_MACHINE_STOPPED"

const Thumbnail = ({
  image,
  index,
  open,
  context,
  inline,
  hasPathLabel,
}: {
  image: EvidenceImage
  index: number
  open: () => void
  context: EvidenceContextValue | null
  inline: boolean
  hasPathLabel: boolean
}) => {
  const root = useRef<HTMLElement>(null)
  const [visible, setVisible] = useState(false)
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [revision, setRevision] = useState(0)
  const [retryable, setRetryable] = useState(false)
  const [ratio, setRatio] = useState("4 / 3")
  const [previewWidth, setPreviewWidth] = useState(480)
  const { notice, saveImage } = useSaveNotice()
  const canOpenComputer =
    error === t("Imagem disponível quando a máquina estiver ligada") && Boolean(context?.onComputer)
  useEffect(() => {
    if (!root.current) return
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: "200px" },
    )
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly retries a previously unavailable image
  useEffect(() => {
    if (!visible) return
    let alive = true
    setError("")
    setSrc(null)
    void loadImage(async () => {
      if (!alive) return
      const owner = image.src ? image : (image.cacheKey ?? context?.api ?? image)
      const key = image.read
        ? image.path
        : JSON.stringify([context?.bot.id, context?.base, context?.imageVersion, image.path])
      const dataUrl = await getCachedThumbnail(owner, key, async () => {
        const blob = await readImage(image, context)
        const dimensions = imageDimensions(new Uint8Array(await blob.slice(0, 131072).arrayBuffer()))
        if (alive && dimensions) {
          setRatio(`${dimensions.width} / ${dimensions.height}`)
          setPreviewWidth(Math.min(480, (320 * dimensions.width) / dimensions.height))
        }
        const small = await thumbnailBlob(blob).catch(() => blob)

        return blobDataUrl(small)
      })
      if (!alive) return
      setSrc(dataUrl)
    }).catch((reason) => {
      if (alive) {
        setError(getImageError(reason))
        setRetryable(canRetryImage(reason))
      }
    })
    return () => {
      alive = false
    }
  }, [image, context, visible, revision])
  useEffect(() => {
    if (!inline || src || !context) return
    return context.api.subscribe(({ event }) => {
      if (event.type === "run.updated" && event.run.botId === context.bot.id && event.run.finishedAt)
        setRevision((value) => value + 1)
    })
  }, [inline, src, context])
  // Bare filenames can describe future work; failed speculative reads need no recovery controls.
  if (
    inline &&
    error &&
    !image.imageSyntax &&
    !image.path.includes("/") &&
    error !== t("Imagem disponível quando a máquina estiver ligada")
  )
    return null

  return (
    <figure ref={root} className="evidence-image">
      <button
        type="button"
        className="evidence-thumbnail"
        style={{ aspectRatio: ratio, maxWidth: previewWidth }}
        aria-label={t("Abrir captura {index} em tamanho original", { index: index + 1 })}
        onClick={open}
      >
        {src ? (
          <img
            src={src}
            alt={image.caption}
            loading="lazy"
            onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget
              if (!width || !height) return
              setRatio(`${width} / ${height}`)
              setPreviewWidth(Math.min(480, (320 * width) / height))
            }}
            onError={() => {
              setSrc(null)
              setError(t("Formato de imagem não suportado"))
              setRetryable(false)
            }}
          />
        ) : (
          <span>{error || t("Carregando imagem…")}</span>
        )}
      </button>
      <figcaption>{image.caption}</figcaption>
      {error && !hasPathLabel && <p className="evidence-path">{image.path}</p>}
      {error && (
        <button type="button" className="text-button" onClick={() => void navigator.clipboard.writeText(image.path)}>
          {t("Copiar caminho")}
        </button>
      )}
      {error && context?.bot.machine === "local" && "__TAURI_INTERNALS__" in window && (
        <button
          type="button"
          className="text-button"
          onClick={() => void createTauriInvoke()("reveal_in_finder", { path: image.path }).catch(() => {})}
        >
          {t("Abrir pasta")}
        </button>
      )}
      {error && retryable && (
        <button
          type="button"
          className="text-button"
          onClick={() => {
            if (canOpenComputer) context?.onComputer?.()
            setRevision((value) => value + 1)
          }}
        >
          {" "}
          {canOpenComputer ? t("Abrir Computador") : t("Tentar novamente")}
        </button>
      )}
      <button
        type="button"
        className="text-button"
        disabled={!image.src && !src}
        onClick={() => void saveImage(() => readImage(image, context), image.filename)}
      >
        {t("Baixar imagem")}
      </button>
      {notice && <p role="status">{notice}</p>}
    </figure>
  )
}

export const EvidenceGallery = ({
  images,
  inline = false,
  hasPathLabel = false,
}: {
  images: EvidenceImage[]
  inline?: boolean
  hasPathLabel?: boolean
}) => {
  const context = useContext(EvidenceContext)
  const [selected, setSelected] = useState<number | null>(null)
  const identity = JSON.stringify(images.map(({ path, caption, filename, src }) => ({ path, caption, filename, src })))
  // biome-ignore lint/correctness/useExhaustiveDependencies: preserve image object identities while streaming surrounding markdown
  const items = useMemo(() => images, [identity, images[0]?.cacheKey])
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: message images form a group of media, not a form fieldset. */}
      <section
        role="group"
        className="evidence-gallery"
        data-image-count={Math.min(3, items.length)}
        aria-label={t("Imagens de evidência")}
      >
        {items.map((image, index) => (
          <Thumbnail
            key={image.path}
            image={image}
            index={index}
            context={context}
            inline={inline}
            hasPathLabel={hasPathLabel}
            open={() => setSelected(index)}
          />
        ))}
      </section>
      {selected !== null && (
        <ImageLightbox
          images={items}
          index={selected}
          select={setSelected}
          close={() => setSelected(null)}
          context={context}
        />
      )}
    </>
  )
}

export const ImageLightbox = ({
  images,
  index,
  select,
  close,
  context,
}: {
  images: EvidenceImage[]
  index: number
  select: (index: number) => void
  close: () => void
  context: EvidenceContextValue | null
}) => {
  const dialog = useRef<HTMLDialogElement>(null)
  const origin = useRef(document.activeElement as HTMLElement | null)
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [zoom, setZoom] = useState(1)
  const [libraryPath, setLibraryPath] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [retryable, setRetryable] = useState(false)
  const stage = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState({ width: 0, height: 0 })
  const [natural, setNatural] = useState({ width: 0, height: 0 })
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number } | null>(null)
  const { notice, saveImage } = useSaveNotice()
  const image = images[index]
  const fit =
    natural.width > 0 && natural.height > 0 && available.width > 0 && available.height > 0
      ? Math.min(available.width / natural.width, available.height / natural.height)
      : 1
  const changeZoom = (step: number) => {
    const next = Math.min(5, Math.max(0.1, zoom + step))
    setZoom(next)
    if (next <= 1) setPan({ x: 0, y: 0 })
  }
  useLayoutEffect(() => {
    const element = stage.current
    if (!element || !src) return
    const measure = () => {
      const { width, height } = element.getBoundingClientRect()
      setAvailable({ width, height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [src])
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => {
      element?.close()
      origin.current?.focus()
    }
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!src) return
      if (event.key === "ArrowRight") {
        event.preventDefault()
        select((index + 1) % images.length)
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault()
        select((index + images.length - 1) % images.length)
      }
    }
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("keydown", onKey)
    }
  }, [index, images.length, select, src])
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision retries a failed image read
  useEffect(() => {
    let alive = true
    setSrc(null)
    setError("")
    setZoom(1)
    setNatural({ width: 0, height: 0 })
    setPan({ x: 0, y: 0 })
    if (image)
      void loadImage(async () => {
        if (!alive) return
        const blob = await readImage(image, context)
        if (!alive) return
        const dataUrl = await blobDataUrl(blob)
        if (!alive) return
        setSrc(dataUrl)
      }).catch((reason) => {
        if (alive) {
          setError(getImageError(reason))
          setRetryable(canRetryImage(reason))
        }
      })
    return () => {
      alive = false
    }
  }, [image, context, revision])
  useEffect(() => {
    let alive = true
    setLibraryPath(null)
    if (!src || !image || image.src || image.read || !context?.onLibrary) return
    const directory = image.path.slice(0, image.path.lastIndexOf("/")) || ""
    void context.api
      .request("GET /bots/:id/files", { path: directory }, { id: context.bot.id })
      .then((result) => {
        const entry = result.files.find((file) => !file.directory && file.name === image.filename)
        if (alive && entry) setLibraryPath(entry.path)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [src, image, context])
  if (!image) return null
  return (
    <dialog ref={dialog} className="evidence-lightbox" aria-label={image.caption} onCancel={close}>
      <header>
        <strong>
          {image.caption} · {index + 1}/{images.length}
        </strong>
        <button type="button" onClick={close}>
          {t("Fechar imagem")}
        </button>
      </header>
      {src && (
        <nav aria-label={t("Controles da imagem")}>
          <button
            type="button"
            disabled={images.length < 2}
            onClick={() => select((index + images.length - 1) % images.length)}
          >
            {t("Anterior")}
          </button>
          <button type="button" disabled={images.length < 2} onClick={() => select((index + 1) % images.length)}>
            {t("Próxima")}
          </button>
          <button type="button" onClick={() => changeZoom(-0.5)}>
            {t("Diminuir zoom")}
          </button>
          <button type="button" onClick={() => changeZoom(0.5)}>
            {t("Aumentar zoom")}
          </button>
          <button
            type="button"
            onClick={() => {
              setZoom(1)
              setPan({ x: 0, y: 0 })
            }}
          >
            {t("Ajustar imagem")}
          </button>
          {context?.onLibrary && libraryPath && (
            <button
              type="button"
              onClick={() => {
                context.onLibrary?.(libraryPath)
                close()
              }}
            >
              {t("Abrir na Biblioteca")}
            </button>
          )}
          <button
            type="button"
            disabled={!src}
            onClick={() => void saveImage(() => readImage(image, context), image.filename)}
          >
            {t("Salvar")}
          </button>
        </nav>
      )}
      {notice && <p role="status">{notice}</p>}
      {error ? (
        <p role="status">
          <span>{error}</span> <span className="evidence-path">{image.path}</span>
          <button type="button" onClick={() => void navigator.clipboard.writeText(image.path)}>
            {t("Copiar caminho")}
          </button>
          {retryable && (
            <button type="button" onClick={() => setRevision((value) => value + 1)}>
              {t("Tentar novamente")}
            </button>
          )}
          {error === t("Imagem disponível quando a máquina estiver ligada") && context?.onComputer && (
            <button type="button" onClick={() => context?.onComputer?.()}>
              {t("Abrir Computador")}
            </button>
          )}
        </p>
      ) : src ? (
        <div
          ref={stage}
          className="evidence-stage"
          onWheel={(event) => changeZoom(event.deltaY < 0 ? 0.25 : -0.25)}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            drag.current = { x: event.clientX - pan.x, y: event.clientY - pan.y }
          }}
          onPointerMove={(event) => {
            if (drag.current && zoom > 1)
              setPan({ x: event.clientX - drag.current.x, y: event.clientY - drag.current.y })
          }}
          onPointerUp={() => {
            drag.current = null
          }}
          onPointerCancel={() => {
            drag.current = null
          }}
        >
          <img
            onError={() => {
              setSrc(null)
              setError(t("Formato de imagem não suportado"))
              setRetryable(false)
            }}
            draggable={false}
            src={src}
            alt={image.caption}
            onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget
              setNatural({ width, height })
            }}
            style={{ transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${fit * zoom})` }}
          />
        </div>
      ) : (
        <p role="status">{t("Carregando imagem…")}</p>
      )}
    </dialog>
  )
}
