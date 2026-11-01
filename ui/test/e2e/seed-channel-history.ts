import { spawn } from "node:child_process"
import { join } from "node:path"
import type { createWorkGoldenServer } from "./work-golden-server"

export const seedLegacyChannelHistory = (
  server: Awaited<ReturnType<typeof createWorkGoldenServer>>,
  threadIds: string[],
  firstTitle = 1,
) =>
  server.restart(
    (directory) =>
      new Promise<void>((done, reject) => {
        const child = spawn(
          "bun",
          [
            join(import.meta.dirname, "channel-history-seed.ts"),
            directory,
            JSON.stringify(threadIds),
            String(firstTitle),
          ],
          { stdio: "ignore", timeout: 30_000, killSignal: "SIGKILL" },
        )
        child.once("error", reject)
        child.once("exit", (code) => {
          if (code !== 0) return reject(new Error("Could not seed synthetic legacy conversations"))

          done()
        })
      }),
  )
