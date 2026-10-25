const CHUNK = 0x8000

/**
 * Turns an image blob into a `data:` URL. The desktop CSP allows `img-src data:` but not `blob:`,
 * so images rendered in the app must never use object URLs. FileReader keeps base64
 * conversion off JavaScript callbacks when a large original opens in the lightbox.
 */
export const blobDataUrl = (blob: Blob): Promise<string> => {
  if (typeof FileReader === "undefined") return getArrayBufferDataUrl(blob)

  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () =>
      typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Image encoding failed"))
    reader.onerror = () => reject(reader.error ?? new Error("Image encoding failed"))
    reader.onabort = () => reject(new Error("Image encoding interrupted"))
    try {
      reader.readAsDataURL(blob)
    } catch {
      // Native host/test blobs may not have the browser's Blob brand.
      void getArrayBufferDataUrl(blob).then(resolve, reject)
    }
  })
}

const getArrayBufferDataUrl = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const binary = Array.from({ length: Math.ceil(bytes.length / CHUNK) }, (_, i) =>
    String.fromCharCode(...bytes.subarray(i * CHUNK, (i + 1) * CHUNK)),
  ).join("")
  return `data:${blob.type || "image/png"};base64,${btoa(binary)}`
}
