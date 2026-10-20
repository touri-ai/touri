import type { Bot } from "@touri/contracts"
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { UiApi } from "../api/client"
import { ApiError } from "../errors"
import { t } from "../i18n"
import { useSaveNotice } from "../useSaveNotice"
import type { EvidenceImage } from "./evidenceMarkdown"
import { loadImage, thumbnailBlob } from "./imageLoads"
import "./evidence-images.css"
import { blobDataUrl } from "../blobDataUrl"

export type EvidenceContextValue = {
  api: UiApi
  bot: Bot
  base?: string
  onLayoutChange?: () => void
  onLibrary?: (path: string, botId?: string) => void
  onComputer?: (botId?: string) => void
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
  if (image.src) return inlineImage(image.src) ?? (await fetch(image.src)).blob()
  if (!context) throw new Error("Imagem indisponível")
  const attachmentId = /^\/(?:api\/v1\/)?attachments\/([a-f0-9]{64})$/i.exec(image.path)?.[1]
  return context.api.request(
    "GET /bots/:id/images",
    attachmentId ? { attachmentId } : { path: image.path, ...(context.base ? { base: context.base } : {}) },
    { id: context.bot.id },
  )
}
const stoppedError = (error: unknown) => error instanceof ApiError && error.errorCode === "IMAGE_MACHINE_STOPPED"

const Thumbnail = ({
  image,
  index,
  open,
  context,
  inline,
}: {
  image: EvidenceImage
  index: number
  open: () => void
  context: EvidenceContextValue | null
  inline: boolean
}) => {
  const root = useRef<HTMLElement>(null)
  const [visible, setVisible] = useState(false)
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [revision, setRevision] = useState(0)
  const { notice, saveImage } = useSaveNotice()
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
      const blob = await readImage(image, context)
      if (!alive) return
      const small = await thumbnailBlob(blob).catch(() => blob)
      if (!alive) return
      const dataUrl = await blobDataUrl(small)
      if (!alive) return
      setSrc(dataUrl)
    }).catch((reason) => {
      if (alive)
        setError(
          stoppedError(reason)
            ? "Imagem disponível quando a máquina estiver ligada"
            : "Prévia indisponível. Clique para abrir a imagem.",
        )
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
  if (inline && !src)
    return (
      <span ref={root}>
        {image.filename}
        {error.startsWith("Imagem disponível") && (
          <span role="status">
            {error}{" "}
            <button type="button" onClick={() => context?.onComputer?.()}>
              Abrir Computador
            </button>
          </span>
        )}
      </span>
    )
  return (
    <figure ref={root} className="evidence-image">
      <button
        type="button"
        className="evidence-thumbnail"
        aria-label={`Abrir captura ${index + 1} em tamanho original`}
        onClick={open}
      >
        {src ? (
          <img
            src={src}
            alt={image.caption}
            loading="lazy"
            onLoad={() => context?.onLayoutChange?.()}
            onError={() => {
              setSrc(null)
              setError("Prévia indisponível. Clique para abrir a imagem.")
            }}
          />
        ) : (
          <span>{error || "Carregando imagem…"}</span>
        )}
      </button>
      <figcaption>{image.caption}</figcaption>
      {error && (
        <button
          type="button"
          className="text-button"
          onClick={() => {
            if (error.startsWith("Imagem disponível")) context?.onComputer?.()
            setRevision((value) => value + 1)
          }}
        >
          {" "}
          {error.startsWith("Imagem disponível") ? "Abrir Computador" : "Tentar novamente"}
        </button>
      )}
      {(image.src || src) && (
        <button
          type="button"
          className="text-button"
          onClick={() => void saveImage(() => readImage(image, context), image.filename)}
        >
          {t("Baixar imagem")}
        </button>
      )}
      {notice && <p role="status">{notice}</p>}
    </figure>
  )
}

export const EvidenceGallery = ({ images, inline = false }: { images: EvidenceImage[]; inline?: boolean }) => {
  const context = useContext(EvidenceContext)
  const [selected, setSelected] = useState<number | null>(null)
  const identity = JSON.stringify(images)
  // biome-ignore lint/correctness/useExhaustiveDependencies: preserve image object identities while streaming surrounding markdown
  const items = useMemo(() => images, [identity])
  return (
    <>
      <section className="evidence-gallery" aria-label="Imagens de evidência">
        {items.map((image, index) => (
          <Thumbnail
            key={image.path}
            image={image}
            index={index}
            context={context}
            inline={inline}
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
  }, [index, images.length, select])
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
        if (alive)
          setError(
            stoppedError(reason)
              ? "Imagem disponível quando a máquina estiver ligada"
              : "Não foi possível abrir esta imagem",
          )
      })
    return () => {
      alive = false
    }
  }, [image, context])
  if (!image) return null
  return (
    <dialog ref={dialog} className="evidence-lightbox" aria-label={image.caption} onCancel={close}>
      <header>
        <strong>
          {image.caption} · {index + 1}/{images.length}
        </strong>
        <button type="button" onClick={close}>
          Fechar imagem
        </button>
      </header>
      <nav aria-label="Controles da imagem">
        <button
          type="button"
          disabled={images.length < 2}
          onClick={() => select((index + images.length - 1) % images.length)}
        >
          Anterior
        </button>
        <button type="button" disabled={images.length < 2} onClick={() => select((index + 1) % images.length)}>
          Próxima
        </button>
        <button type="button" onClick={() => changeZoom(-0.5)}>
          Diminuir zoom
        </button>
        <button type="button" onClick={() => changeZoom(0.5)}>
          Aumentar zoom
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(1)
            setPan({ x: 0, y: 0 })
          }}
        >
          Ajustar imagem
        </button>
        {context?.onLibrary && !image.src && (
          <button
            type="button"
            onClick={() => {
              context.onLibrary?.(image.path)
              close()
            }}
          >
            Abrir na Biblioteca
          </button>
        )}
        {src && (
          <button type="button" onClick={() => void saveImage(() => readImage(image, context), image.filename)}>
            Salvar
          </button>
        )}
      </nav>
      {notice && <p role="status">{notice}</p>}
      {error ? (
        <p role="status">
          {error}{" "}
          {error.startsWith("Imagem disponível") && (
            <button type="button" onClick={() => context?.onComputer?.()}>
              Abrir Computador
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
        <p role="status">Carregando imagem…</p>
      )}
    </dialog>
  )
}
