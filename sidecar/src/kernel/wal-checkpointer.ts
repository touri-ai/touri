const DEFAULT_INTERVAL_MS = 5_000

export const createWalCheckpointer = ({
  filename,
  onError,
  intervalMs = DEFAULT_INTERVAL_MS,
}: {
  filename: string
  onError: () => void
  intervalMs?: number
}): { dispose: () => void } => {
  const worker = new Worker(new URL("./wal-checkpoint-worker.ts", import.meta.url), {
    smol: true,
    ref: false,
  })
  let stopped = false
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  let reportedError = false

  const finish = (): void => {
    if (stopTimer) clearTimeout(stopTimer)
    worker.terminate()
  }
  const reportError = (): void => {
    if (stopped || reportedError) return
    reportedError = true
    onError()
  }

  worker.onmessage = ({ data }: MessageEvent<{ type?: string }>): void => {
    if (data?.type === "error") reportError()
    if (data?.type === "stopped") finish()
  }
  worker.onerror = reportError
  worker.postMessage({ type: "start", filename, intervalMs })

  return {
    dispose: (): void => {
      if (stopped) return
      stopped = true
      worker.postMessage({ type: "stop" })
      stopTimer = setTimeout(finish, 1_000)
    },
  }
}
