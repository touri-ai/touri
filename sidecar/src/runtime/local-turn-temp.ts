import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { Kernel, StartTurnArgs } from "@touri/contracts"
import { ensurePrivateDirectory } from "../kernel/files"

export const withLocalTurnTemp = async <T>(
  kernel: Kernel,
  args: StartTurnArgs,
  run: (args: StartTurnArgs) => Promise<T>,
): Promise<T> => {
  if (args.execution) return run(args)
  const directory = join(kernel.paths.runDir, "provider-tmp")
  ensurePrivateDirectory({ root: kernel.paths.appData, path: directory })
  const temporary = realpathSync(mkdtempSync(join(directory, "turn-")))
  try {
    return await run({
      ...args,
      env: { ...args.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary, TMPPREFIX: join(temporary, "zsh") },
    })
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
