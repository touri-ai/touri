import { setImmediate } from "node:timers/promises"
import { promisify } from "node:util"
import { brotliCompress, constants, gzip } from "node:zlib"

type Encoding = "br" | "gzip"
export type CompressedVariants = Record<Encoding, Uint8Array<ArrayBuffer>> & { size: number }

const minimumBytes = 1024
const compressBrotli = promisify(brotliCompress)
const compressGzip = promisify(gzip)
const runCompression = createCompressionRunner()

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

const getCompressedBytes = (bytes: Uint8Array<ArrayBuffer>, encoding: Encoding): Promise<Uint8Array<ArrayBuffer>> => {
  const pending = runCompression(bytes.byteLength, async () => {
    const compressed = await (encoding === "br"
      ? compressBrotli(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
      : compressGzip(bytes, { level: 4 }))

    return new Uint8Array(compressed)
  })

  // An identity response remains usable when compression admission is full.
  return pending ?? Promise.resolve(bytes)
}

export function createCompressionRunner() {
  // Local counters bound retained input while native jobs execute one at a time.
  let previous: Promise<void> = Promise.resolve()
  let pendingBytes = 0
  let pendingJobs = 0

  return <Result>(size: number, compress: () => Promise<Result>): Promise<Result> | null => {
    if (pendingBytes + size > 64 * 1024 * 1024 || pendingJobs >= 64) return null

    pendingBytes += size
    pendingJobs += 1
    const release = () => {
      pendingBytes -= size
      pendingJobs -= 1

      return setImmediate()
    }
    const pending = previous.then(compress)
    previous = pending.then(release, release)

    return pending
  }
}

export const compressibleType = (type: string): boolean => {
  const mime = type.split(";")[0]?.trim().toLowerCase() ?? ""
  return (
    (mime.startsWith("text/") && mime !== "text/event-stream") ||
    /^application\/(?:json|javascript|xml|[\w.+-]+\+(?:json|xml))$/.test(mime)
  )
}

export const compressedVariants = async (bytes: Uint8Array<ArrayBuffer>): Promise<CompressedVariants> => {
  const [br, gzip] = await Promise.all([getCompressedBytes(bytes, "br"), getCompressedBytes(bytes, "gzip")])

  return { size: bytes.byteLength, br, gzip }
}

/** Only pass buffered responses; route streams and WebSocket upgrades bypass this helper. */
export const compressBufferedResponse = async (
  request: Request,
  response: Response,
  variants?: () => Promise<CompressedVariants>,
): Promise<Response> => {
  if (isBrowserFrameRequest(request)) {
    response.headers.set("Cache-Control", "no-store, no-transform")
    return response
  }
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
    compressed = await getCompressedBytes(bytes, encoding)
  }
  if (compressed.byteLength >= size) return bytes ? new Response(head ? null : bytes, response) : unchanged()
  response.headers.set("Content-Encoding", encoding)
  response.headers.set("Content-Length", String(compressed.byteLength))
  return new Response(head ? null : compressed, response)
}

const isBrowserFrameRequest = (request: Request): boolean => {
  if (request.method !== "POST") return false
  return /^\/(?:api\/(?:v1\/)?)?browser\/tabs\/[^/]+\/takeover\/frame$/u.test(new URL(request.url).pathname)
}
