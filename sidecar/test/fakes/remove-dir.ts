import { rmSync } from "node:fs"

// Windows keeps a just-exited executable locked for a moment; retry instead of failing the cleanup with EBUSY.
export const removeDir = (path: string) =>
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
