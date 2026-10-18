import { rm } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"

type CleanupIo = {
  remove: (path: string) => Promise<void>
  wait: (milliseconds: number) => Promise<void>
}

export async function removeSmokeDirectory(
  root: string,
  { remove = removeDirectory, wait = sleep }: Partial<CleanupIo> = {},
) {
  // Bun 1.4.3 parses fs.rm's retry options but does not apply them on removal.
  // Keep the smoke's existing 20 retries and linear backoff, yielding between attempts.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await remove(root)
      return
    } catch (error) {
      if (!isTransientRemovalError(error) || attempt === 20) throw error
    }
    await wait((attempt + 1) * 100)
  }
}

const removeDirectory = (path: string) => rm(path, { recursive: true, force: true })
const transientCodes = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"])

function isTransientRemovalError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    transientCodes.has(error.code)
  )
}
