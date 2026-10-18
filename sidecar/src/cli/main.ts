import { parseCli, usageText } from "./args"
import { runCommandLine } from "./commands"

const main = async (): Promise<void> => {
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
