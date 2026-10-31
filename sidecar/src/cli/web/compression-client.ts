type Encoding = "br" | "gzip"
type Session = { worker: Worker; url: string }

export const createCompressionClient = ({
  createWorker = (url: string) => new Worker(url, { smol: true, ref: false }),
}: {
  createWorker?: (url: string) => Worker
} = {}) => {
  // This resource boundary owns one CPU worker; callers retain their original response bytes.
  let session: Session | undefined
  let active = false
  let cancel: (() => void) | undefined

  const stop = (current: Session): void => {
    if (session === current) session = undefined
    current.worker.terminate()
    URL.revokeObjectURL(current.url)
  }
  const start = (): Session => {
    if (session) return session

    const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }))
    try {
      const worker = createWorker(url)
      const current = { worker, url }
      worker.addEventListener("close", () => {
        URL.revokeObjectURL(url)
        if (session !== current) return
        session = undefined
        cancel?.()
      })
      session = current

      return current
    } catch (error) {
      URL.revokeObjectURL(url)
      throw error
    }
  }
  const run = (bytes: Uint8Array<ArrayBuffer>, encoding: Encoding): Promise<Uint8Array<ArrayBuffer>> => {
    if (active) return Promise.resolve(bytes)

    const current = (() => {
      try {
        return start()
      } catch {
        return null
      }
    })()
    if (!current) return Promise.resolve(bytes)

    active = true
    return new Promise((resolve) => {
      let finished = false
      const finish = (result = bytes, failed = false): void => {
        if (finished) return
        finished = true
        active = false
        cancel = undefined
        clearTimeout(timer)
        current.worker.onmessage = null
        current.worker.onerror = null
        if (failed) stop(current)
        resolve(result)
      }
      const timer = setTimeout(() => finish(bytes, true), 5000)
      cancel = () => finish(bytes, true)
      current.worker.onmessage = ({ data }: MessageEvent<unknown>): void => {
        if (!(data instanceof Uint8Array)) {
          finish(bytes, true)
          return
        }
        const buffer = data.buffer
        if (!(buffer instanceof ArrayBuffer)) {
          finish(bytes, true)
          return
        }

        finish(new Uint8Array(buffer, data.byteOffset, data.byteLength))
      }
      current.worker.onerror = (event): void => {
        event.preventDefault()
        finish(bytes, true)
      }
      try {
        current.worker.postMessage({ bytes, encoding })
      } catch {
        finish(bytes, true)
      }
    })
  }
  const close = (): void => {
    if (cancel) {
      cancel()
      return
    }
    if (session) stop(session)
  }

  return { run, close }
}

// Synchronous codecs run only on this dedicated worker, outside request and streaming callbacks.
const source = `
import { brotliCompressSync, constants } from "node:zlib";
self.onmessage = ({ data }) => {
  try {
    if (!(data.bytes instanceof Uint8Array) || !["br", "gzip"].includes(data.encoding)) throw new Error("Invalid compression task");
    const encoded = data.encoding === "br"
      ? brotliCompressSync(data.bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
      : Bun.gzipSync(data.bytes, { level: 4 });
    const bytes = new Uint8Array(encoded);
    self.postMessage(bytes, [bytes.buffer]);
  } catch {
    self.postMessage(null);
  }
};
`
