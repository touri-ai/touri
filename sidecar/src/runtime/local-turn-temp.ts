import { chmod, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import type { Kernel, StartTurnArgs } from "@touri/contracts"
import { ensurePrivateDirectoryAsync } from "../kernel/async-files"
import { refreshHostFolderAccess } from "../kernel/folder-capability"

export const withLocalTurnTemp = async <T>(
  kernel: Kernel,
  args: StartTurnArgs,
  run: (args: StartTurnArgs) => Promise<T>,
): Promise<T> => {
  if (args.execution) return run(args)
  if (process.platform === "linux" || args.bot.anyFolderAccess || args.bot.folders?.length)
    await refreshHostFolderAccess()
  const directory = join(kernel.paths.runDir, "provider-tmp")
  await ensurePrivateDirectoryAsync({ root: kernel.paths.appData, path: directory })
  const temporary = await mkdtemp(join(directory, "turn-"))
  await chmod(temporary, 0o700)
  try {
    return await run({
      ...args,
      env: { ...args.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary, TMPPREFIX: join(temporary, "zsh") },
    })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
