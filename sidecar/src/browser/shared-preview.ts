import type { BrowserEngine } from "./types"

const MAX_PREVIEW_SOURCES = 32
const MAX_PREVIEW_BYTES = 2_000_000
const PREVIEW_REUSE_MS = 700

type Preview = Awaited<ReturnType<BrowserEngine["preview"]>>
type PreviewSource = {
  tabId: string
  botId: string
  controller: AbortController
  pending: Promise<Preview> | null
  frame: Preview
  expiresAt: number
  readers: number
}

export const createSharedBrowserPreview = ({
  capture,
  now = Date.now,
}: {
  capture: BrowserEngine["preview"]
  now?: () => number
}) => {
  // The coordinator owns this bounded map; invalidation also cancels pending publication.
  const sources = new Map<string, PreviewSource>()
  const encodedFrames = new WeakMap<NonNullable<Preview>, Uint8Array>()
  const invalidate = (tabId: string): void => {
    sources.forEach((source) => {
      if (source.tabId !== tabId) return
      source.controller.abort()
      if (source.frame) encodedFrames.delete(source.frame)
      source.frame = null
      source.expiresAt = 0
    })
  }
  const invalidateBot = (botId: string): void => {
    sources.forEach((source) => {
      if (source.botId === botId) invalidate(source.tabId)
    })
  }
  const get = async ({
    botId,
    tabId,
    signal,
  }: {
    botId: string
    tabId: string
    signal: AbortSignal
  }): Promise<Preview> => {
    if (signal.aborted) return null
    const key = JSON.stringify([botId, tabId])
    const current = sources.get(key)
    if (current?.pending) return waitForPreview(current, signal)
    if (current?.frame && current.expiresAt > now()) return current.frame
    if (!current && sources.size >= MAX_PREVIEW_SOURCES) {
      const expired = Array.from(sources).find(([, source]) => !source.pending && source.expiresAt <= now())
      if (!expired) return null
      sources.delete(expired[0])
    }

    const controller = new AbortController()
    const source: PreviewSource = { tabId, botId, controller, pending: null, frame: null, expiresAt: 0, readers: 0 }
    sources.set(key, source)
    const pending = capture({ botId, tabId, signal: controller.signal })
      .then((frame) => {
        if (controller.signal.aborted || !frame || frame.image.length > MAX_PREVIEW_BYTES) return null
        source.frame = frame
        source.expiresAt = now() + PREVIEW_REUSE_MS
        return frame
      })
      .catch(() => null)
      .finally(() => {
        source.pending = null
      })
    source.pending = pending

    return waitForPreview(source, signal)
  }
  const getEncoded = (frame: NonNullable<Preview>): Uint8Array => {
    const current = encodedFrames.get(frame)
    if (current) return current
    const encoded = new TextEncoder().encode(JSON.stringify(frame))
    encodedFrames.set(frame, encoded)

    return encoded
  }
  const dispose = (): void => {
    sources.forEach((source) => {
      source.controller.abort()
      if (source.frame) encodedFrames.delete(source.frame)
    })
    sources.clear()
  }

  return { get, getEncoded, invalidate, invalidateBot, dispose }
}

const waitForPreview = (source: PreviewSource, signal: AbortSignal): Promise<Preview> => {
  const pending = source.pending
  if (!pending) return Promise.resolve(null)
  source.readers += 1

  return new Promise((resolve) => {
    let settled = false
    const complete = (frame: Preview): void => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", cancel)
      source.controller.signal.removeEventListener("abort", cancel)
      source.readers -= 1
      if (source.readers === 0 && source.pending && !source.controller.signal.aborted) source.controller.abort()
      resolve(signal.aborted || source.controller.signal.aborted ? null : frame)
    }
    const cancel = (): void => complete(null)
    signal.addEventListener("abort", cancel, { once: true })
    source.controller.signal.addEventListener("abort", cancel, { once: true })
    if (signal.aborted || source.controller.signal.aborted) return cancel()
    void pending.then(complete)
  })
}
