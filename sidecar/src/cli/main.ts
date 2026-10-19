import { parseCli, usageText } from "./args"
import { runCommandLine } from "./commands"

const main = async (): Promise<void> => {
  if (process.argv[2] === "write-bot-home") {
    const { runBotHomeWriter } = await import("../store/bot-home")
    const { createAppPaths } = await import("../kernel/paths")
    try {
      await runBotHomeWriter(createAppPaths().appData)
    } catch {
      process.exitCode = 1
    }
    return
  }
  const parsed = parseCli(process.argv.slice(2))
  if (!parsed.success) {
    process.stderr.write(`${parsed.error}\n\n${usageText}`)
    process.exitCode = 2
    return
  }
  const code = await runCommandLine(parsed.command)
  if (code >= 0) process.exit(code)
}

if (import.meta.main) await main()
