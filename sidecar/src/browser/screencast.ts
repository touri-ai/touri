import type { CdpClient, CdpEvent } from "./types"

type Frame = { image: string; width: number; height: number }

// The browser owns encoding. One unacknowledged image bounds memory and pauses capture when the viewer leaves.
export const createBrowserScreencast = async ({
  client,
  sessionId,
  width,
  height,
}: {
  client: CdpClient
  sessionId: string
  width: number
  height: number
}) => {
  let pending: { frame: Frame; ids: number[] } | null = null
  let last: Frame | null = null
  let stopped = false
  let screenshotRequired = false
  let wake: (() => void) | undefined
  let acknowledgements = Promise.resolve()
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const unsubscribe = client.subscribe((event: CdpEvent) => {
    if (stopped || event.sessionId !== sessionId || event.method !== "Page.screencastFrame") return
    const { data, sessionId: id } = event.params
    if (typeof id !== "number") return
    if (typeof data !== "string" || data.length > 450_000) {
      screenshotRequired = true
      stop()
      return
    }
    pending = {
      frame: { image: `data:image/jpeg;base64,${data}`, width, height },
      ids: [...(pending?.ids ?? []), id].slice(-3),
    }
    wake?.()
  })
  const stop = () => {
    if (stopped) return
    stopped = true
    clearTimeout(idleTimer)
    unsubscribe()
    wake?.()
    pending = null
    last = null
    void client.call("Page.stopScreencast", {}, sessionId).catch(() => undefined)
  }
  try {
    await client.call(
      "Page.startScreencast",
      { format: "jpeg", quality: 70, maxWidth: width, maxHeight: height, everyNthFrame: 1 },
      sessionId,
    )
  } catch (error) {
    stop()
    throw error
  }

  const read = async (signal: AbortSignal): Promise<Frame | null> => {
    clearTimeout(idleTimer)
    await acknowledgements
    if (stopped || signal.aborted) return null
    if (!pending) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          signal.removeEventListener("abort", done)
          wake = undefined
          resolve()
        }
        const timer = setTimeout(done, 750)
        wake = done
        signal.addEventListener("abort", done, { once: true })
      })
    }
    idleTimer = setTimeout(stop, 2_000)
    if (stopped || signal.aborted) return null
    const next = pending
    pending = null
    if (!next) return last
    last = next.frame
    acknowledgements = Promise.all(
      next.ids.map((id) => client.call("Page.screencastFrameAck", { sessionId: id }, sessionId)),
    )
      .then(() => undefined)
      .catch(stop)
    return next.frame
  }

  const refresh = () => {
    const stale = pending
    pending = null
    last = null
    if (!stale) return
    acknowledgements = Promise.all(
      stale.ids.map((id) => client.call("Page.screencastFrameAck", { sessionId: id }, sessionId)),
    )
      .then(() => undefined)
      .catch(stop)
  }

  return { read, stop, refresh, isStopped: () => stopped, needsScreenshot: () => screenshotRequired }
}
