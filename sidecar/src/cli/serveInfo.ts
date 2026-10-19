import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { removePrivateFileAsync, writePrivateFileAsync } from "../kernel/async-files"

export type ServeInfo = {
  pid: number
  host: string
  port: number
  startedAt: number
  version: string
  url: string | null
  noPair: boolean
}

export const serveInfoPath = (dataDir: string): string => join(dataDir, "run", "serve.json")

export const writeServeInfo = ({ dataDir, info }: { dataDir: string; info: ServeInfo }): Promise<void> =>
  writePrivateFileAsync({ root: dataDir, path: serveInfoPath(dataDir), content: JSON.stringify(info) })

export const clearServeInfo = (dataDir: string): Promise<void> =>
  removePrivateFileAsync({ root: dataDir, path: serveInfoPath(dataDir) })

export const readServeInfo = (dataDir: string): ServeInfo | null => {
  const path = serveInfoPath(dataDir)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ServeInfo
  } catch {
    return null
  }
}

export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
