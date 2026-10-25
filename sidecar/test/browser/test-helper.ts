import { existsSync } from "node:fs"

export const systemChromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
export const hasSystemChrome = existsSync(systemChromePath)

export const forceHeadlessBrowserTests = (): void => {
  process.env.TOURI_BROWSER_HEADLESS = "1"
}

export const assertHeadlessLaunchArgs = ({ args }: { args: Array<string> }): void => {
  if (!args.includes("--headless=new"))
    throw new Error(`Chrome for browser tests was launched without --headless=new: ${args.join(" ")}`)
  const pipe = args.includes("--remote-debugging-pipe")
  // The production launcher falls back when legacy Bun cannot establish a pipe.
  // An ephemeral loopback port and the test's private profile are also isolated.
  const portArg = args.find((arg) => /^--remote-debugging-port=[1-9]\d{0,4}$/u.test(arg))
  const port = Number(portArg?.split("=")[1])
  const localPort =
    args.includes("--remote-debugging-address=127.0.0.1") &&
    Number.isInteger(port) &&
    port <= 65535 &&
    args.some((arg) => arg.startsWith("--user-data-dir="))
  if (
    (!pipe && !localPort) ||
    args.some(
      (arg) =>
        arg.startsWith("--remote-debugging-") &&
        !["--remote-debugging-pipe", "--remote-debugging-address=127.0.0.1", portArg].includes(arg),
    )
  )
    throw new Error(`Chrome browser tests require an isolated CDP pipe or ephemeral loopback port: ${args.join(" ")}`)
}

export const assertNoTestChrome = async ({ profile }: { profile: string }): Promise<void> => {
  const matchingProcesses = async (): Promise<Array<string>> => {
    // macOS pgrep has no -a flag; ignoring that error made the old check always pass.
    const child = Bun.spawn({ cmd: ["/bin/ps", "-axo", "pid=,command="], stdout: "pipe", stderr: "ignore" })
    const [output, exit] = await Promise.all([new Response(child.stdout).text(), child.exited])
    if (exit !== 0) throw new Error("Unable to check browser test Chrome processes")
    return output.split("\n").filter((line) => line.includes("Google Chrome") && line.includes(profile))
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await matchingProcesses()).length === 0) return
    await Bun.sleep(100)
  }
  throw new Error(
    `Browser test Chrome was not cleaned up for profile ${profile}: ${(await matchingProcesses()).join("\n")}`,
  )
}

forceHeadlessBrowserTests()
