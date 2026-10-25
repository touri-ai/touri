import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

type Capability = { available: true } | { available: false; reason: string }

export const getSystemBrowserCapability = async (): Promise<Capability> => {
  if (process.platform !== "linux") return { available: false, reason: "Linux headful fixture only" }
  const executable = Bun.which("google-chrome")
  if (!executable) return { available: false, reason: "Stable system browser is not installed" }
  if (!Bun.which("Xvfb")) return { available: false, reason: "Virtual display is not installed" }

  const root = await mkdtemp(join(tmpdir(), "touri-browser-capability-"))
  const child = Bun.spawn(
    [executable, `--user-data-dir=${root}`, "--headless=new", "--no-first-run", "--dump-dom", "about:blank"],
    { stdout: "ignore", stderr: "pipe" },
  )
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000)
  try {
    const [exitCode, diagnostics] = await Promise.all([child.exited, new Response(child.stderr).text()])

    return getBrowserSandboxCapability(exitCode, diagnostics)
  } finally {
    clearTimeout(timer)
    child.kill("SIGKILL")
    await child.exited
    await rm(root, { recursive: true, force: true })
  }
}

export const getBrowserSandboxCapability = (exitCode: number, diagnostics: string): Capability => {
  if (exitCode === 0) return { available: true }
  if (/No usable sandbox|Failed to move to new namespace|Running as root without --no-sandbox/u.test(diagnostics))
    return { available: false, reason: "Host cannot start the system browser with its sandbox enabled" }

  throw new Error(`System browser capability probe failed (exit ${exitCode})`)
}
