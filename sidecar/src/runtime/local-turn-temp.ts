import { chmod, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import type { Kernel, StartTurnArgs } from "@touri/contracts"
import { ensurePrivateDirectoryAsync } from "../kernel/async-files"
import { refreshHostFolderAccess } from "../kernel/folder-capability"
import { folderConfinementRequired } from "./folder-access"

export const withLocalTurnTemp = async <T>(
  kernel: Kernel,
  args: StartTurnArgs,
  run: (args: StartTurnArgs) => Promise<T>,
  getLifetime?: (temporary: string) => Promise<unknown> | undefined,
  prepareFolders = refreshHostFolderAccess,
): Promise<T> => {
  if (args.execution) return run(args)
  if (folderConfinementRequired(args)) await prepareFolders()
  args.onPreparationStage?.("sandboxReadyAt")
  const directory = join(kernel.paths.runDir, "provider-tmp")
  await ensurePrivateDirectoryAsync({ root: kernel.paths.appData, path: directory })
  const temporary = await mkdtemp(join(directory, "turn-"))
  await chmod(temporary, 0o700)
  try {
    args.onPreparationStage?.("temporaryReadyAt")
    return await run({
      ...args,
      env: { ...args.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary, TMPPREFIX: join(temporary, "zsh") },
    })
  } finally {
    const lifetime = getLifetime?.(temporary)
    if (lifetime) void lifetime.finally(() => rm(temporary, { recursive: true, force: true })).catch(() => undefined)
    else await rm(temporary, { recursive: true, force: true })
  }
}
