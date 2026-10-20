// A single queue bounds decoding/network work across all mounted messages.
let active = 0
const queue: Array<() => void> = []
export const loadImage = async <T>(action: () => Promise<T>): Promise<T> => {
  await new Promise<void>((resolve) => {
    const start = () => {
      active++
      resolve()
    }
    if (active < 3) start()
    else queue.push(start)
  })
  try {
    return await action()
  } finally {
    active--
    queue.shift()?.()
  }
}
/** Read only a bounded header to retain aspect ratio while decoding directly at thumbnail size. */
export const imageDimensions = (bytes: Uint8Array): { width: number; height: number } | null => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))
  let width = 0
  let height = 0
  if (bytes.length >= 24 && text(1, 4) === "PNG") {
    width = view.getUint32(16)
    height = view.getUint32(20)
  } else if (bytes.length >= 10 && text(0, 3) === "GIF") {
    width = view.getUint16(6, true)
    height = view.getUint16(8, true)
  } else if (bytes.length >= 30 && text(0, 4) === "RIFF" && text(8, 12) === "WEBP") {
    if (text(12, 16) === "VP8X") {
      width = 1 + (bytes[24] ?? 0) + ((bytes[25] ?? 0) << 8) + ((bytes[26] ?? 0) << 16)
      height = 1 + (bytes[27] ?? 0) + ((bytes[28] ?? 0) << 8) + ((bytes[29] ?? 0) << 16)
    } else if (text(12, 16) === "VP8L") {
      width = 1 + (bytes[21] ?? 0) + (((bytes[22] ?? 0) & 63) << 8)
      height = 1 + ((bytes[22] ?? 0) >> 6) + ((bytes[23] ?? 0) << 2) + (((bytes[24] ?? 0) & 15) << 10)
    } else if (text(12, 16) === "VP8 ") {
      width = view.getUint16(26, true) & 16383
      height = view.getUint16(28, true) & 16383
    }
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2; offset + 9 <= bytes.length; ) {
      if (bytes[offset] !== 255) break
      const marker = bytes[offset + 1] ?? 0
      if (marker === 255) {
        offset++
        continue
      }
      const length = view.getUint16(offset + 2)
      if (length < 2) break
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        width = view.getUint16(offset + 7)
        height = view.getUint16(offset + 5)
        break
      }
      offset += length + 2
    }
  }
  return width > 0 && height > 0 ? { width, height } : null
}
export const getThumbnailSize = (
  size: { width: number; height: number },
  devicePixelRatio = 1,
): { width: number; height: number } => {
  const pixelRatio = Number.isFinite(devicePixelRatio) ? Math.min(3, Math.max(1, devicePixelRatio)) : 1
  const scale = Math.min(1, (480 * pixelRatio) / size.width, (320 * pixelRatio) / size.height)
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  }
}
export const thumbnailBlob = async (blob: Blob): Promise<Blob> => {
  if (typeof createImageBitmap !== "function") throw new Error("Prévia indisponível")
  const size = imageDimensions(new Uint8Array(await blob.slice(0, 131072).arrayBuffer()))
  const thumbnail = getThumbnailSize(size ?? { width: 480, height: 320 }, window.devicePixelRatio)
  const bitmap = await createImageBitmap(blob, {
    resizeWidth: thumbnail.width,
    resizeHeight: thumbnail.height,
    resizeQuality: "high",
  })
  try {
    const canvas = document.createElement("canvas")
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0)
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error("Prévia indisponível"))),
        "image/webp",
        0.9,
      ),
    )
  } finally {
    bitmap.close()
  }
}
