import { dirname } from "node:path"
import { TouriError } from "../kernel/errors"
import { MAX_ATTACHMENT_BYTES } from "../kernel/files"
import type { GrantedFileTarget } from "../kernel/readGrantedFile"
import { buildChildEnv } from "../kernel/shell-env"
import { desktopHelper } from "./windows-native"

export const readWindowsGrantedFile = async ({
  target,
  signal,
  command = [desktopHelper(), "--read-granted-file"],
  timeoutMs = 10_000,
}: {
  target: GrantedFileTarget
  signal: AbortSignal
  command?: string[]
  timeoutMs?: number
}): Promise<Buffer> => {
  signal.throwIfAborted()
  if (!Number.isSafeInteger(target.maxBytes) || target.maxBytes <= 0 || target.maxBytes > MAX_ATTACHMENT_BYTES)
    throw new TouriError("TOURI-E2001")
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  const child = Bun.spawn({ cmd: command, stdin: "pipe", stdout: "pipe", stderr: "ignore", env: buildChildEnv() })
  const stop = () => child.kill("SIGKILL")
  deadline.addEventListener("abort", stop, { once: true })
  try {
    child.stdin.write(
      JSON.stringify({
        op: "read_granted",
        root: dirname(target.path),
        path: target.path,
        dev: target.dev,
        ino: target.ino,
        max_bytes: target.maxBytes,
      }),
    )
    child.stdin.end()
    const bytes = await getBytes(child.stdout, target.maxBytes)
    const exitCode = await child.exited
    deadline.throwIfAborted()
    if (exitCode !== 0) throw new TouriError("TOURI-E2001")

    return bytes
  } finally {
    deadline.removeEventListener("abort", stop)
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
  }
}

const getBytes = async (stream: ReadableStream<Uint8Array>, maximum: number): Promise<Buffer> => {
  const reader = stream.getReader()
  // Retain bounded chunks locally, then copy once rather than copying the growing file per chunk.
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maximum) throw new TouriError("TOURI-E2001")
      chunks.push(chunk.value)
    }
    return Buffer.concat(chunks, size)
  } finally {
    reader.releaseLock()
  }
}
