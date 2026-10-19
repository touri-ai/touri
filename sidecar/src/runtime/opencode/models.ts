import { randomUUID } from "node:crypto"
import type { Bot, Kernel } from "@touri/contracts"
import { buildChildEnv } from "../../kernel"
import { writePrivateFileAsync } from "../../kernel/async-files"
import { deepSeekDefault } from "./adapter"
import { isolatedOpenCodeEnv, openCodeBinary, providerSecretEnv, readOpenCodeAuth } from "./config"

export const listOpenCodeModels = async (kernel: Kernel, bot?: Bot) => {
  const base = buildChildEnv({
    base: await kernel.shellEnv(),
    overrides: bot ? await providerSecretEnv(kernel, bot) : await providerSecretEnv(kernel, { projectId: null }),
  })
  const binary = openCodeBinary(base)
  if (!binary.success) return { models: [], defaultModel: null, available: false }
  const root = `${kernel.paths.runDir}/opencode-models/${randomUUID()}`
  const configPath = `${root}/opencode.json`
  await writePrivateFileAsync({
    root: kernel.paths.appData,
    path: configPath,
    content: JSON.stringify({ autoupdate: false, plugin: [], permission: "deny" }),
  })
  const authPath = `${root}/data/opencode/auth.json`
  await writePrivateFileAsync({ root: kernel.paths.appData, path: authPath, content: readOpenCodeAuth(kernel, base) })
  const env = isolatedOpenCodeEnv(base, root, `${root}/data`, configPath)
  const child = kernel.spawnTree({ cmd: binary.path, args: ["models", "--pure"], cwd: root, env })
  if (!child.success) return { models: [], defaultModel: null, available: false }
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000)
  try {
    const [output, , exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const models =
      exit.code === 0
        ? [
            ...new Set(
              output
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter((s) => /^[\w.-]+\/[\w./:@+-]+$/.test(s)),
            ),
          ].sort()
        : []
    return { models, defaultModel: deepSeekDefault(models), available: exit.code === 0 }
  } finally {
    clearTimeout(timer)
    await writePrivateFileAsync({ root: kernel.paths.appData, path: authPath, content: "{}" })
  }
}
