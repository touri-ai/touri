type BrowserPreviewFrameRequest = {
  id: number
  title: string
  url: string
} & (
  | { image: string; pixels?: never; width?: never; height?: never }
  | { image?: never; bitmap: ImageBitmap; pixels?: never; width?: never; height?: never }
)

type BrowserPreviewFrameResponse = {
  id: number
  title: string
  url: string
  src?: string
  error?: string
}

const MAX_SOURCE_PIXELS = 8_000_000
const MAX_IMAGE_DATA_URL_LENGTH = 24_000_000
const FRAME_WIDTH = 640
const FRAME_HEIGHT = 400

const getImageBlob = (value: string): Blob => {
  if (value.length > MAX_IMAGE_DATA_URL_LENGTH) throw new Error("The browser preview is too large.")
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value)
  if (!match) throw new Error("The browser preview image is invalid.")
  const [, type = "application/octet-stream", base64, payload = ""] = match
  if (!base64) return new Blob([decodeURIComponent(payload)], { type })
  if (payload.length > MAX_IMAGE_DATA_URL_LENGTH) throw new Error("The browser preview is too large.")

  const binary = atob(payload)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))

  return new Blob([bytes], { type })
}

const getFrameBlob = async (request: BrowserPreviewFrameRequest): Promise<Blob> => {
  const canvas = new OffscreenCanvas(FRAME_WIDTH, FRAME_HEIGHT)
  const context = canvas.getContext("2d")
  if (!context) throw new Error("The browser preview could not be drawn.")

  const bitmap = "bitmap" in request ? request.bitmap : await createImageBitmap(getImageBlob(request.image))
  try {
    if (bitmap.width * bitmap.height > MAX_SOURCE_PIXELS) throw new Error("The browser preview is too large.")
    const ratio = Math.min(FRAME_WIDTH / bitmap.width, FRAME_HEIGHT / bitmap.height)
    const width = bitmap.width * ratio
    const height = bitmap.height * ratio
    context.drawImage(bitmap, (FRAME_WIDTH - width) / 2, (FRAME_HEIGHT - height) / 2, width, height)
  } finally {
    bitmap.close()
  }

  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.65 })
}

const getDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result)
      else reject(new Error("The browser preview image could not be encoded."))
    })
    reader.addEventListener("error", () => reject(new Error("The browser preview image could not be encoded.")))
    reader.readAsDataURL(blob)
  })

const worker = self as Pick<Worker, "addEventListener" | "postMessage">

worker.addEventListener("message", (event) => {
  const request = (event as MessageEvent<BrowserPreviewFrameRequest>).data
  void getFrameBlob(request)
    .then(getDataUrl)
    .then((src) => worker.postMessage({ id: request.id, title: request.title, url: request.url, src }))
    .catch(() =>
      worker.postMessage({
        id: request.id,
        title: request.title,
        url: request.url,
        error: "The browser preview could not be processed.",
      } satisfies BrowserPreviewFrameResponse),
    )
})
