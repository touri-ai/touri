import { parseCli, usageText } from "./args"
import { runCommandLine } from "./commands"
import { relayHeadlessStderr } from "./serveStderr"

const main = async (): Promise<void> => {
  const parsed = parseCli(process.argv.slice(2))
  if (!parsed.success) {
    process.stderr.write(`${parsed.error}\n\n${usageText}`)
    process.exitCode = 2
    return
  }
  if (parsed.command.name === "serve" && process.platform === "linux" && process.env[stderrRelayEnvironment] !== "1") {
    process.exitCode = await runHeadlessServeWithStderrRelay()
    return
  }

  const code = await runCommandLine(parsed.command)
  if (code >= 0) process.exit(code)
}

const stderrRelayEnvironment = "TOURI_SERVE_STDERR_RELAY"

const runHeadlessServeWithStderrRelay = async (): Promise<number> => {
  const child = Bun.spawn({
    cmd: [process.execPath, ...process.argv.slice(1)],
    env: { ...process.env, [stderrRelayEnvironment]: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "pipe",
  })
  const forwardInterrupt = (): void => child.kill("SIGINT")
  const forwardTermination = (): void => child.kill("SIGTERM")
  process.on("SIGINT", forwardInterrupt)
  process.on("SIGTERM", forwardTermination)

  try {
    const [exitCode] = await Promise.all([
      child.exited,
      relayHeadlessStderr(child.stderr, async (text) => {
        if (process.stderr.write(text)) return
        await new Promise<void>((resolve) => process.stderr.once("drain", resolve))
      }),
    ])
    return exitCode
  } catch (error) {
    child.kill("SIGTERM")
    await child.exited
    throw error
  } finally {
    process.off("SIGINT", forwardInterrupt)
    process.off("SIGTERM", forwardTermination)
  }
}

if (import.meta.main) await main()
