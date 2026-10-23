import { fileURLToPath } from "node:url"
import { createAppPaths } from "./paths"

/** Migrations own their connection in a child; even an old store cannot stall liveness. */
export const prepareDatabaseAsync = async (appData: string, signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted()
  const devArgs = Bun.isStandaloneExecutable ? [] : [fileURLToPath(import.meta.url)]
  const child = Bun.spawn([process.execPath, ...devArgs, "prepare-store"], {
    env: Object.assign({}, process.env, { TOURI_APP_DATA: appData }),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  const abort = () => child.kill("SIGKILL")
  const timer = setTimeout(abort, 120_000)
  signal.addEventListener("abort", abort, { once: true })

  try {
    const code = await child.exited
    signal.throwIfAborted()
    if (code !== 0) throw new Error("STORE_STARTUP_FAILED")
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
  }
}

export const prepareDatabase = async (): Promise<void> => {
  const { openDatabase } = await import("./db")
  const database = openDatabase({ filename: createAppPaths().db })
  database.close()
}

if (import.meta.main) await prepareDatabase()
