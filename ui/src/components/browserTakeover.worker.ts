type FrameMessage = { type: "frame"; frameId: number; image: string } | { type: "canvas"; canvas: OffscreenCanvas }

let canvas: OffscreenCanvas | null = null
let drawing = false
let pendingFrame: { frameId: number; image: string } | null = null

const imageBlob = (value: string): Blob => {
  const separator = value.indexOf(",")
  if (!value.startsWith("data:") || separator < 0) throw new Error("Invalid browser frame")
  const metadata = value.slice(5, separator).split(";")
  const mime = metadata[0] || "application/octet-stream"
  const payload = value.slice(separator + 1)
  if (!metadata.includes("base64")) return new Blob([decodeURIComponent(payload)], { type: mime })

  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: mime })
}

const drawFrames = async (): Promise<void> => {
  if (!canvas || drawing || !pendingFrame) return
  drawing = true
  while (canvas && pendingFrame) {
    const frame = pendingFrame
    pendingFrame = null
    const bitmap = await createImageBitmap(imageBlob(frame.image))
    try {
      if (!canvas) return
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0)
      self.postMessage({ type: "drawn", frameId: frame.frameId })
    } finally {
      bitmap.close()
    }
  }
  drawing = false
}

self.addEventListener("message", (event: MessageEvent<FrameMessage>) => {
  if (event.data.type === "canvas") {
    canvas = event.data.canvas
    return
  }
  pendingFrame = { frameId: event.data.frameId, image: event.data.image }
  void drawFrames().catch(() => {
    drawing = false
    Reflect.apply(self.postMessage, self, [{ type: "error" }, []])
  })
})
