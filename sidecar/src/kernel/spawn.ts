import { dlopen } from "bun:ffi"
import { closeSync, createWriteStream, existsSync, read as readFd, write as writeFd } from "node:fs"
import type { Kernel } from "@touri/contracts"
import { withToolPath } from "./shell-env"

type SpawnResult = ReturnType<Kernel["spawnTree"]>

const openLegacyLibc = () =>
  dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    dup: { args: ["i32"], returns: "i32" },
  })
let legacyLibc: ReturnType<typeof openLegacyLibc> | undefined
let extraPipeMode: "socket-fd" | "pipe" = "socket-fd"

const isMissingExecutable = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false
  return "code" in error && error.code === "ENOENT"
}

const asWritableStream = (input: Bun.FileSink | number | undefined): WritableStream<Uint8Array> =>
  new WritableStream<Uint8Array>({
    write: async (chunk) => {
      if (typeof input === "number") {
        const output = createWriteStream("/dev/null", { fd: input, autoClose: false })
        output.write(chunk)
        await new Promise<void>((resolve, reject) => {
          output.once("error", reject)
          output.once("drain", resolve)
          if (output.writableNeedDrain === false) resolve()
        })
        output.end()
      } else {
        input?.write(chunk)
        input?.flush()
      }
    },
    close: () => {
      if (typeof input !== "number") input?.end()
    },
  })

const extraPipe = (descriptor: number) => {
  let closed = false
  let readTimer: ReturnType<typeof setTimeout> | undefined
  let finishRead: (() => void) | undefined
  const close = (): void => {
    if (closed) return
    closed = true
    clearTimeout(readTimer)
    finishRead?.()
    try {
      closeSync(descriptor)
    } catch {}
  }
  const read = new ReadableStream<Uint8Array>(
    {
      pull: (controller) =>
        new Promise<void>((resolve) => {
          finishRead = resolve
          // Allocate only when a consumer asks for data, and reuse on EAGAIN.
          const buffer = Buffer.allocUnsafe(64 * 1024)
          const pump = (): void => {
            if (closed) {
              resolve()
              return
            }
            readFd(descriptor, buffer, 0, buffer.length, null, (error, bytes) => {
              if (closed) return resolve()
              if (error?.code === "EAGAIN") {
                readTimer = setTimeout(pump, 1)
                return
              }
              finishRead = undefined
              if (error) {
                controller.error(error)
                close()
              } else if (bytes === 0) {
                controller.close()
                close()
              } else controller.enqueue(new Uint8Array(buffer.subarray(0, bytes)))
              resolve()
            })
          }
          pump()
        }),
      cancel: close,
    },
    { highWaterMark: 0 },
  )
  const write = new WritableStream<Uint8Array>({
    write: (chunk) =>
      new Promise<void>((resolve, reject) => {
        let offset = 0
        const writeChunk = (): void => {
          if (closed) {
            reject(new Error("Child pipe is closed"))
            return
          }
          if (offset === chunk.length) {
            resolve()
            return
          }
          writeFd(descriptor, chunk, offset, chunk.length - offset, null, (error, bytes) => {
            if (error?.code === "EAGAIN") {
              setTimeout(writeChunk, 1)
              return
            }
            if (error) return reject(error)
            if (bytes === 0) return reject(new Error("Child pipe write made no progress"))
            offset += bytes
            writeChunk()
          })
        }
        writeChunk()
      }),
    close,
    abort: close,
  })
  return { read, write }
}

export const spawnTree = ({
  cmd,
  args,
  cwd,
  env,
  extraFds = 0,
}: {
  cmd: string
  args: Array<string>
  cwd: string
  env: Record<string, string>
  extraFds?: number
}): SpawnResult => {
  try {
    const spawn = () => {
      const stdio: ["pipe", "pipe", "pipe", ...Array<"socket-fd" | "pipe">] = [
        "pipe",
        "pipe",
        "pipe",
        ...Array.from({ length: extraFds }, () => extraPipeMode),
      ]
      return Bun.spawn({
        cmd: [cmd, ...args],
        cwd,
        env: { ...env, PATH: withToolPath(env).PATH },
        detached: true,
        stdio,
      })
    }
    const child = (() => {
      try {
        return spawn()
      } catch (error) {
        if (
          extraFds === 0 ||
          extraPipeMode !== "socket-fd" ||
          !(error instanceof Error) ||
          !error.message.includes("stdio must be an array")
        )
          throw error
        extraPipeMode = "pipe"
        return spawn()
      }
    })()
    const extras = child.stdio.slice(3).map((descriptor) => {
      if (descriptor === null) return { read: null, write: null }
      if (extraPipeMode === "socket-fd") return extraPipe(descriptor)
      // Bun 1.2 closes extra "pipe" fds again during subprocess GC. Own a
      // duplicate so cancellation cannot make GC close a reused descriptor.
      legacyLibc ??= openLegacyLibc()
      const owned = legacyLibc.symbols.dup(descriptor)
      if (owned < 0) throw new Error("Unable to duplicate child pipe")
      return extraPipe(owned)
    })
    const exited = child.exited.then((code) => ({
      code: code === 0 ? 0 : code || null,
      signal: child.signalCode === null ? null : String(child.signalCode),
    }))
    return {
      success: true,
      pid: child.pid,
      pgid: child.pid,
      stdout: child.stdout,
      stderr: child.stderr,
      stdin: asWritableStream(child.stdin),
      extra: extras,
      exited,
      kill: (signal) => {
        try {
          process.kill(-child.pid, signal)
        } catch {
          child.kill(signal)
        }
      },
    }
  } catch (error) {
    if (isMissingExecutable(error) && !existsSync(cwd))
      return { success: false, error: `Working directory does not exist: ${cwd}`, errorCode: "SPAWN_FAILED" }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      errorCode: isMissingExecutable(error) ? "ENOENT" : "SPAWN_FAILED",
    }
  }
}
