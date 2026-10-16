import { brotliCompressSync, constants } from "node:zlib"

type Encoding = "br" | "gzip"
export type CompressedVariants = Record<Encoding, Uint8Array<ArrayBuffer>> & { size: number }

const minimumBytes = 1024

const acceptedEncoding = (header: string | null): Encoding | null => {
  const qualities = new Map<string, number>()
  for (const part of (header ?? "").toLowerCase().split(",")) {
    const [name, ...parameters] = part.trim().split(";")
    if (!name) continue
    const parameter = parameters.find((value) => value.trim().startsWith("q="))
    const quality = parameter === undefined ? 1 : Number(parameter.trim().slice(2))
    qualities.set(name, Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0)
  }
  const quality = (encoding: Encoding) => qualities.get(encoding) ?? qualities.get("*") ?? 0
  const br = quality("br")
  const gzip = quality("gzip")
  const best = Math.max(br, gzip)
  if (best === 0 || (qualities.get("identity") ?? 0) > best) return null
  return br >= gzip ? "br" : "gzip"
}

const compress = (bytes: Uint8Array<ArrayBuffer>, encoding: Encoding): Uint8Array<ArrayBuffer> =>
  encoding === "br"
    ? brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
    : Bun.gzipSync(bytes, { level: 4 })

export const compressibleType = (type: string): boolean => {
  const mime = type.split(";")[0]?.trim().toLowerCase() ?? ""
  return (
    (mime.startsWith("text/") && mime !== "text/event-stream") ||
    /^application\/(?:json|javascript|xml|[\w.+-]+\+(?:json|xml))$/.test(mime)
  )
}

export const compressedVariants = (bytes: Uint8Array<ArrayBuffer>): CompressedVariants => ({
  size: bytes.byteLength,
  br: compress(bytes, "br"),
  gzip: compress(bytes, "gzip"),
})

/** Only pass buffered responses; route streams and WebSocket upgrades bypass this helper. */
export const compressBufferedResponse = async (
  request: Request,
  response: Response,
  variants?: () => Promise<CompressedVariants>,
): Promise<Response> => {
  const head = request.method === "HEAD"
  const unchanged = () => (head ? new Response(null, response) : response)
  if (
    response.body === null ||
    response.status < 200 ||
    [204, 205, 206, 304].includes(response.status) ||
    response.headers.has("content-encoding") ||
    response.headers.has("content-range") ||
    request.headers.get("upgrade")?.toLowerCase() === "websocket" ||
    /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(response.headers.get("cache-control") ?? "") ||
    !compressibleType(response.headers.get("content-type") ?? "")
  )
    return unchanged()

  const vary = response.headers.get("vary")
  if (!vary?.split(",").some((value) => ["*", "accept-encoding"].includes(value.trim().toLowerCase())))
    response.headers.append("Vary", "Accept-Encoding")
  const encoding = acceptedEncoding(request.headers.get("accept-encoding"))
  const length = response.headers.get("content-length")
  if (!encoding || (length !== null && Number(length) < minimumBytes)) return unchanged()

  let bytes: Uint8Array<ArrayBuffer> | null = null
  let size: number
  let compressed: Uint8Array<ArrayBuffer>
  if (variants) {
    const cached = await variants()
    size = cached.size
    compressed = cached[encoding]
  } else {
    bytes = new Uint8Array(await response.arrayBuffer())
    size = bytes.byteLength
    if (size < minimumBytes) return new Response(head ? null : bytes, response)
    compressed = compress(bytes, encoding)
  }
  if (compressed.byteLength >= size) return bytes ? new Response(head ? null : bytes, response) : unchanged()
  response.headers.set("Content-Encoding", encoding)
  response.headers.set("Content-Length", String(compressed.byteLength))
  return new Response(head ? null : compressed, response)
}
