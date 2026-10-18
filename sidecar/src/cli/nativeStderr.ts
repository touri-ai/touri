import { dlopen } from "bun:ffi"
import { closeOnExec, libcLibrary } from "../platform/posix"
import { relayHeadlessStderr } from "./serveStderr"

/** Capture native runtime writes too, without another server process or blocking its event loop. */
export const startHeadlessStderr = async (): Promise<() => Promise<void>> => {
  const noop = async (): Promise<void> => {}
  if (process.platform !== "linux") return noop

  // These fixed descriptor operations run before server startup and do no data I/O.
  const library = dlopen(libcLibrary, {
    fcntl: { args: ["i32", "i32", "i32"], returns: "i32" },
    pipe2: { args: ["ptr", "i32"], returns: "i32" },
    dup2: { args: ["i32", "i32"], returns: "i32" },
    close: { args: ["i32"], returns: "i32" },
  })
  const native = library.symbols
  const original = native.fcntl(2, 1030, 3) // F_DUPFD_CLOEXEC keeps the saved destination out of child processes.
  const pipe = new Int32Array([-1, -1])
  if (original < 0 || native.pipe2(pipe, closeOnExec) < 0) {
    if (original >= 0) native.close(original)
    library.close()
    return noop
  }

  const input = pipe[0] ?? -1
  const output = pipe[1] ?? -1
  const url = URL.createObjectURL(new Blob([getStderrWorkerSource()], { type: "application/javascript" }))
  // Descriptor and worker lifecycle state is local to this capture, including its failure fallback.
  let worker: Worker | undefined
  let redirected = false
  let closed = false
  let stopped: Promise<void> | undefined
  let finish = (): void => {}
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  const restore = (): void => {
    if (!redirected) return
    native.dup2(original, 2)
    redirected = false
  }
  const cleanup = (): void => {
    if (closed) return
    restore()
    closed = true
    worker?.terminate()
    native.close(input)
    native.close(original)
    library.close()
    URL.revokeObjectURL(url)
  }

  try {
    worker = new Worker(url, { smol: true, ref: false })
    const ready = waitForStderrWorker(worker, restore, finish)
    worker.postMessage({ input, original })
    await ready
    if (native.dup2(output, 2) < 0) throw new Error()
    redirected = true
  } catch {
    native.close(output)
    cleanup()
    return noop
  }

  native.close(output)
  return (): Promise<void> => {
    if (stopped) return stopped
    restore()
    stopped = new Promise<void>((resolve) => {
      const deadline = setTimeout(resolve, 2_000)
      void done.then(() => {
        clearTimeout(deadline)
        resolve()
      })
    }).then(cleanup)
    return stopped
  }
}

const waitForStderrWorker = (worker: Worker, restore: () => void, finish: () => void): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error()), 5_000)
    const fail = (): void => {
      clearTimeout(deadline)
      restore()
      finish()
      reject(new Error())
    }
    worker.onmessage = ({ data }: MessageEvent<string>): void => {
      if (data === "stopped") finish()
      if (data !== "ready") return
      clearTimeout(deadline)
      resolve()
    }
    worker.onerror = (event): void => {
      event.preventDefault()
      fail()
    }
    worker.addEventListener("close", fail)
  })

// Only repository-authored code and built-in imports enter this worker, including in compiled binaries.
const getStderrWorkerSource = (): string => `
import { createReadStream, createWriteStream } from "node:fs"
import { Readable } from "node:stream"
self.onmessage = async ({ data }) => {
  const input = createReadStream("", { fd: data.input, autoClose: false, highWaterMark: 8192 })
  const output = createWriteStream("", { fd: data.original, autoClose: false, highWaterMark: 8192 })
  self.postMessage("ready")
  await (${relayHeadlessStderr.toString()})(Readable.toWeb(input), (text) => new Promise((resolve, reject) => {
    output.write(text, (error) => error ? reject(error) : resolve())
  }))
  self.postMessage("stopped")
  self.close()
}
`
