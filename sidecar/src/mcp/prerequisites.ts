import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel, McpPrerequisites } from "@touri/contracts"
import { buildChildEnv } from "../kernel/shell-env"

const unavailable = (machine: Bot["machine"]): McpPrerequisites => ({
  machine,
  status: "unavailable",
  node: false,
  oauthKeys: false,
  credentials: false,
})

const filePresent = (path: string) =>
  stat(path).then(
    (info) => info.isFile(),
    () => false,
  )

// Only presence flags leave the machine; credential contents and paths stay private.
export const mcpPrerequisites = async (kernel: Kernel, bot: Bot): Promise<McpPrerequisites> => {
  if (bot.machine === "cloud") return unavailable(bot.machine)
  if (bot.machine === "vm") {
    const vm = kernel.services.use("vm.runtime")
    if (!vm) return unavailable(bot.machine)
    let release: (() => Promise<void>) | undefined
    try {
      release = await vm.acquire({ botId: bot.id, runningOnly: true, signal: AbortSignal.timeout(5000) })
      const result = await vm.exec({
        botId: bot.id,
        command: "sh",
        args: [
          "-c",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Shell expansion uses the guest environment.
          'command -v npx >/dev/null && node -e \'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)\' >/dev/null 2>&1 && printf 1 || printf 0; test -f "${GMAIL_OAUTH_PATH:-${MCP_CONFIG_DIR:-$HOME/.gmail-mcp}/gcp-oauth.keys.json}" && printf 1 || printf 0; test -f "${GMAIL_CREDENTIALS_PATH:-${MCP_CONFIG_DIR:-$HOME/.gmail-mcp}/credentials.json}" && printf 1 || printf 0',
        ],
        signal: AbortSignal.timeout(5000),
      })
      if (!result.success || result.code !== 0 || !/^[01]{3}$/.test(result.stdout.trim()))
        return unavailable(bot.machine)
      const flags = result.stdout.trim()
      return {
        machine: bot.machine,
        status: "checked",
        node: flags[0] === "1",
        oauthKeys: flags[1] === "1",
        credentials: flags[2] === "1",
      }
    } catch {
      return unavailable(bot.machine)
    } finally {
      await release?.()
    }
  }
  const env = buildChildEnv({ base: await kernel.shellEnv() })
  const home = env.HOME ?? homedir()
  const directory = env.MCP_CONFIG_DIR ?? join(home, ".gmail-mcp")
  const nodeCommand = Bun.which("node", { PATH: env.PATH ?? "" })
  let node = false
  if (nodeCommand && Bun.which("npx", { PATH: env.PATH ?? "" })) {
    const child = Bun.spawn([nodeCommand, "--version"], { env, stdout: "pipe", stderr: "ignore", timeout: 5000 })
    const version = await new Response(child.stdout).text()
    node = (await child.exited) === 0 && Number(/^v(\d+)\./.exec(version)?.[1] ?? 0) >= 18
  }
  const [oauthKeys, credentials] = await Promise.all([
    filePresent(env.GMAIL_OAUTH_PATH ?? join(directory, "gcp-oauth.keys.json")),
    filePresent(env.GMAIL_CREDENTIALS_PATH ?? join(directory, "credentials.json")),
  ])
  return { machine: bot.machine, status: "checked", node, oauthKeys, credentials }
}
