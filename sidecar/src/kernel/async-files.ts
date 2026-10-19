import { createFileIoLane, logIoByteLimit } from "./file-io-client"
import type { FileIoTask } from "./file-io-protocol"
import type { FileWrite } from "./files"

const requestIo = createFileIoLane()
const backgroundIo = createFileIoLane({ maxBytes: logIoByteLimit, batch: true })
const runFileIoTask = (task: FileIoTask): Promise<unknown> => requestIo.run(task)

/** Await every accepted write before reading logs. */
export const flushFileIoAsync = (): Promise<void> =>
  Promise.all([requestIo.flush(), backgroundIo.flush()]).then(() => undefined)

/** Stop producers first; terminate both workers if durable writes exceed the deadline. */
export const closeFileIoAsync = (timeoutMs = 5000): Promise<void> =>
  Promise.all([requestIo.close(timeoutMs), backgroundIo.close(timeoutMs)]).then(() => undefined)

export const getFileIoStats = () => ({
  request: requestIo.getStats(),
  background: backgroundIo.getStats(),
})

export const appendBackgroundFileAsync = (args: FileWrite & { maxBytes?: number }): Promise<void> =>
  backgroundIo.run({ operation: "append", args }).then(() => undefined)

export const writePrivateFileAsync = (args: FileWrite): Promise<void> =>
  runFileIoTask({ operation: "write", args }).then(() => undefined)

export const appendPrivateFileAsync = (args: FileWrite & { maxBytes?: number }): Promise<void> =>
  runFileIoTask({ operation: "append", args }).then(() => undefined)

export const ensurePrivateDirectoryAsync = (args: { root: string; path?: string; mode?: number }): Promise<void> =>
  runFileIoTask({ operation: "ensure-directory", args }).then(() => undefined)

export const removePrivateFileAsync = (args: { root: string; path: string }): Promise<void> =>
  runFileIoTask({ operation: "remove", args }).then(() => undefined)

export const movePrivateFileAsync = (args: { root: string; from: string; to: string }): Promise<void> =>
  runFileIoTask({ operation: "move", args }).then(() => undefined)

export const privateFileExistsAsync = (args: { root: string; path: string }): Promise<boolean> =>
  runFileIoTask({ operation: "exists", args }).then(Boolean)

export const prepareDatabaseFileAsync = (args: { root: string; path: string }): Promise<string> =>
  runFileIoTask({ operation: "prepare-database", args }).then((filename) => String(filename))

export const appendLogFileAsync = (args: {
  root: string
  path: string
  content: Uint8Array
  maxBytes: number
  retainedGenerations: number
}): Promise<void> => backgroundIo.run({ operation: "append-log", args }).then(() => undefined)

export const createWorkspaceDirectoryAsync = (args: {
  root: string
  path: string
  identity: { dev: number; ino: number }
}): Promise<void> => runFileIoTask({ operation: "create-workspace-directory", args }).then(() => undefined)

export const rotatePrivateDirectoryAsync = (args: {
  root: string
  directory: string
  retainedFiles: number
}): Promise<void> => backgroundIo.run({ operation: "rotate-directory", args }).then(() => undefined)

export const removePrivateFileIfMatchesAsync = (args: { root: string; path: string; content: string }): Promise<void> =>
  runFileIoTask({ operation: "remove-if-matches", args }).then(() => undefined)

export const replacePrivateSymlinkAsync = (args: { root: string; path: string; target: string }): Promise<void> =>
  runFileIoTask({ operation: "replace-symlink", args }).then(() => undefined)

export const removeBotHomeDirectoryAsync = (args: { root: string; path: string; botId: string }): Promise<void> =>
  backgroundIo.run({ operation: "remove-bot-home", args }).then(() => undefined)
