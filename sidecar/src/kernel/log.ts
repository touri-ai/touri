import { readdirSync } from "node:fs"
import { join } from "node:path"
import type { AppPaths, Kernel } from "@touri/contracts"
import { appendLogFileAsync } from "./async-files"
import { atomicWriteFile, ensurePrivateDirectory, readPrivateFile, removePrivateFile } from "./files"
import { redactStructured } from "./redact"

const maxLogBytes = 10 * 1024 * 1024
const retainedGenerations = 5

const encodedLogLine = (line: string): Uint8Array => {
  const encoded = Buffer.from(`${line}\n`, "utf8")
  if (encoded.byteLength <= maxLogBytes) return encoded
  const bounded = new TextDecoder().decode(encoded.subarray(0, maxLogBytes - 4))
  return Buffer.from(`${bounded}\n`, "utf8")
}

export const createLogger = ({
  paths,
  redact,
}: {
  paths: AppPaths
  redact: (text: string) => string
}): Kernel["log"] => {
  ensurePrivateDirectory({ root: paths.appData, path: paths.logsDir })
  const filename = join(paths.logsDir, "sidecar.log")
  for (const name of readdirSync(paths.logsDir)) {
    const generation = name.match(/^sidecar\.log\.(\d+)$/)?.[1]
    if (name === "sidecar.log" || (generation && Number(generation) <= retainedGenerations)) {
      const path = join(paths.logsDir, name)
      const content = readPrivateFile({ root: paths.appData, path })
      if (content) atomicWriteFile({ root: paths.appData, path, content })
    } else if (generation) removePrivateFile({ root: paths.appData, path: join(paths.logsDir, name) })
  }
  return (entry) => {
    const line = JSON.stringify(redactStructured({ at: Date.now(), ...entry }, redact))
    const encoded = encodedLogLine(line)
    void appendLogFileAsync({
      root: paths.appData,
      path: filename,
      content: encoded,
      maxBytes: maxLogBytes,
      retainedGenerations,
    }).catch(() => undefined)
    if (entry.level === "error" || entry.level === "warn") process.stderr.write(`${line}\n`)
  }
}
