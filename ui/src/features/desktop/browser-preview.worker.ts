type BrowserPreviewFrameRequest = { id: number; title: string; url: string } & (
  | { image: string; pixels?: never; width?: never; height?: never }
  | { image?: never; pixels: ArrayBuffer; width: number; height: number }
)

type BrowserPreviewFrameResponse = { id: number; title: string; url: string; src?: string; error?: true }

const MAX_SOURCE_PIXELS = 8_000_000
const MAX_IMAGE_DATA_URL_LENGTH = 2_100_000
const FRAME_WIDTH = 640
const FRAME_HEIGHT = 400

const getImageBlob = (value: string): Blob => {
  if (value.length > MAX_IMAGE_DATA_URL_LENGTH) throw new Error("image too large")
  const match = /^data:image\/jpeg;base64,([\s\S]*)$/.exec(value)
  const payload = match?.[1]
  if (!payload) throw new Error("invalid image")
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  // The input is size-limited above, so this conversion is bounded and stays in the worker.
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)

  return new Blob([bytes], { type: "image/jpeg" })
}

const getImageBitmap = async (request: BrowserPreviewFrameRequest): Promise<ImageBitmap> => {
  if (typeof request.image === "string") return createImageBitmap(getImageBlob(request.image))
  const pixels = request.pixels
  const width = request.width
  const height = request.height
  if (!pixels || typeof width !== "number" || typeof height !== "number") throw new Error("invalid image size")
  const pixelCount = width * height
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    pixelCount > MAX_SOURCE_PIXELS ||
    pixels.byteLength !== pixelCount * 4
  )
    throw new Error("invalid image size")

  const source = new OffscreenCanvas(width, height)
  const context = source.getContext("2d")
  if (!context) throw new Error("canvas unavailable")
  context.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0)

  return createImageBitmap(source)
}

const getFrameBlob = async (request: BrowserPreviewFrameRequest): Promise<Blob> => {
  const bitmap = await getImageBitmap(request)
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > MAX_SOURCE_PIXELS)
      throw new Error("invalid image size")
    const canvas = new OffscreenCanvas(FRAME_WIDTH, FRAME_HEIGHT)
    const context = canvas.getContext("2d")
    if (!context) throw new Error("canvas unavailable")
    context.fillStyle = "#fff"
    context.fillRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT)
    const ratio = Math.min(FRAME_WIDTH / bitmap.width, FRAME_HEIGHT / bitmap.height)
    const width = bitmap.width * ratio
    const height = bitmap.height * ratio
    context.drawImage(bitmap, (FRAME_WIDTH - width) / 2, (FRAME_HEIGHT - height) / 2, width, height)

    return await canvas.convertToBlob({ type: "image/jpeg", quality: 0.55 })
  } finally {
    bitmap.close()
  }
}

const getDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result)
      else reject(new Error("image encoding failed"))
    })
    reader.addEventListener("error", () => reject(new Error("image encoding failed")))
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
        error: true,
      } satisfies BrowserPreviewFrameResponse),
    )
})
