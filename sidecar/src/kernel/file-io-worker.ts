import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { removeBotHomeDirectory } from "../vm/bot-home-cleanup"
import type { FileIoMessage, FileIoRequest, FileIoTask } from "./file-io-protocol"
import {
  atomicAppendFile,
  atomicWriteFile,
  createWorkspaceDirectory,
  ensurePrivateDirectory,
  movePrivateFile,
  prepareDatabaseFile,
  readPrivateFile,
  removePrivateFile,
  replacePrivateSymlink,
} from "./files"

const rotateLog = ({
  root,
  path,
  retainedGenerations,
}: {
  root: string
  path: string
  retainedGenerations: number
}): void => {
  for (let index = retainedGenerations; index >= 1; index -= 1) {
    const current = `${path}.${index}`
    if (!readPrivateFile({ root, path: current, maxBytes: 1 })) continue
    if (index === retainedGenerations) removePrivateFile({ root, path: current })
    else movePrivateFile({ root, from: current, to: `${path}.${index + 1}` })
  }
  if (readPrivateFile({ root, path, maxBytes: 1 })) movePrivateFile({ root, from: path, to: `${path}.1` })
}

const execute = (task: FileIoTask): unknown => {
  if (task.operation === "flush") return undefined
  if (task.operation === "write") {
    atomicWriteFile(task.args)
    return undefined
  }
  if (task.operation === "append") {
    atomicAppendFile(task.args)
    return undefined
  }
  if (task.operation === "ensure-directory") {
    ensurePrivateDirectory(task.args)
    return undefined
  }
  if (task.operation === "remove") {
    removePrivateFile(task.args)
    return undefined
  }
  if (task.operation === "move") {
    movePrivateFile(task.args)
    return undefined
  }
  if (task.operation === "exists") return readPrivateFile({ ...task.args, maxBytes: 1 }) !== null
  if (task.operation === "read-private") return readPrivateFile(task.args)?.toString("base64") ?? null
  if (task.operation === "prepare-database") return prepareDatabaseFile(task.args)
  if (task.operation === "create-workspace-directory") {
    createWorkspaceDirectory(task.args)
    return undefined
  }
  if (task.operation === "rotate-directory") {
    const files = readdirSync(task.args.directory)
      .map((name) => join(task.args.directory, name))
      .filter((path) => {
        try {
          return statSync(path).isFile()
        } catch {
          return false
        }
      })
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    for (const path of files.slice(task.args.retainedFiles)) {
      try {
        removePrivateFile({ root: task.args.root, path })
      } catch {}
    }
    return undefined
  }
  if (task.operation === "remove-if-matches") {
    const content = readPrivateFile({ root: task.args.root, path: task.args.path })
    if (content?.toString() === task.args.content) removePrivateFile({ root: task.args.root, path: task.args.path })
    return undefined
  }
  if (task.operation === "replace-symlink") {
    replacePrivateSymlink(task.args)
    return undefined
  }
  if (task.operation === "remove-bot-home") {
    removeBotHomeDirectory(task.args)
    return undefined
  }

  const current = readPrivateFile({ root: task.args.root, path: task.args.path, maxBytes: task.args.maxBytes + 1 })
  if ((current?.byteLength ?? 0) + task.args.content.byteLength > task.args.maxBytes) rotateLog(task.args)
  atomicAppendFile({ ...task.args, maxBytes: task.args.maxBytes })
  return undefined
}

const toWorkerError = (error: unknown): { name: string; message: string; code?: string } => {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) }
  const code = (error as Error & { code?: unknown }).code
  return { name: error.name, message: error.message, ...(typeof code === "string" ? { code } : {}) }
}

self.onmessage = ({ data }: MessageEvent<FileIoRequest>): void => {
  if ("type" in data && data.type === "start") {
    self.postMessage({ type: "ready" } satisfies FileIoMessage)
    return
  }
  if (!("requestId" in data)) return
  try {
    const result = execute(data)
    self.postMessage({ requestId: data.requestId, result } satisfies FileIoMessage)
  } catch (error) {
    self.postMessage({ requestId: data.requestId, error: toWorkerError(error) } satisfies FileIoMessage)
  }
}
