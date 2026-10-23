import { parseCli, usageText } from "./args"

const main = async (): Promise<void> => {
  if (process.argv[2] === "transcript-retention") {
    const { runTranscriptRetention } = await import("../kernel/transcript-retention-process")
    await runTranscriptRetention()
    return
  }
  if (process.argv[2] === "prepare-store") {
    const { prepareDatabase } = await import("../kernel/database-startup")
    await prepareDatabase()
    return
  }
  if (process.argv[2] === "store-read") {
    const { runStoreRead } = await import("../store/read-process")
    await runStoreRead()
    return
  }
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
  if (parsed.command.name === "serve") {
    const { runServeCommand } = await import("./serve")
    await runServeCommand(parsed.command.options)
    return
  }
  const { runCommandLine } = await import("./commands")
  const code = await runCommandLine(parsed.command)
  if (code >= 0) process.exit(code)
}

if (import.meta.main) await main()
