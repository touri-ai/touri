/** Account-free compiled-binary onboarding, shared by Linux and Windows CI. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { removeSmokeDirectory } from "./smoke-cleanup"

const windows = process.platform === "win32"
const target = windows
  ? "x86_64-pc-windows-msvc.exe"
  : process.arch === "arm64"
    ? "aarch64-unknown-linux-gnu"
    : "x86_64-unknown-linux-gnu"
const binary = resolve(`src-tauri/binaries/touri-sidecar-${target}`)
if (!existsSync(binary)) throw new Error("Build the native platform sidecar before running its compiled smoke")
mkdirSync("src-tauri/target", { recursive: true })
const root = mkdtempSync(resolve("src-tauri/target/sidecar-smoke-"))
const fake = join(root, windows ? "fixture-provider.exe" : "fixture-provider")
const compiled = Bun.spawnSync(
  [process.execPath, "build", "--compile", "sidecar/test/fakes/fake-codex.ts", "--outfile", fake],
  { stdout: "inherit", stderr: "inherit" },
)
if (compiled.exitCode !== 0) throw new Error("Inert provider fixture did not compile")
const appData = join(root, "data")
const scenario = join(root, "scenario.json")
writeFileSync(scenario, JSON.stringify({ deltas: ["Compiled platform fixture reply"] }))
const env: NodeJS.ProcessEnv = {
  ...process.env,
  TOURI_APP_DATA: appData,
  TOURI_PARENT_PID: String(process.pid),
  TOURI_UI_TOKEN: "fixture-ui-token",
  TOURI_CODEX_BIN: fake,
  TOURI_CLAUDE_BIN: fake,
  TOURI_OPENCODE_BIN: fake,
  TOURI_FAKE_SCENARIO: scenario,
  TOURI_VM_INTEGRATION: "0",
  TOURI_E2E_REAL_CLI: "0",
  TOURI_OPENCODE_REAL: "0",
  TOURI_DOCTOR_SKIP_PROVIDER_PROBES: "1",
}
if (windows) {
  env.TOURI_DESKTOP_HELPER = process.env.TOURI_DESKTOP_HELPER ?? resolve("src-tauri/target/debug/touri.exe")
  // Stop the sidecar the way the desktop shell does on Windows: by closing its stdin.
  env.TOURI_SHUTDOWN_ON_STDIN_EOF = "1"
}
const child = Bun.spawn({
  cmd: [binary, "serve"],
  env,
  stdin: "pipe",
  stdout: Bun.file(join(root, "stdout.log")),
  stderr: Bun.file(join(root, "stderr.log")),
})
const wait = async (ready: () => boolean | Promise<boolean>, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs
  while (!(await ready())) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error("Compiled sidecar smoke did not become ready")
    await Bun.sleep(50)
  }
}
try {
  const handshakePath = join(appData, "run", "handshake.json")
  await wait(() => existsSync(handshakePath), 120_000)
  const logPath = join(appData, "logs", "sidecar.log")
  await wait(
    () => existsSync(logPath) && readFileSync(logPath, "utf8").includes('"msg":"WAL checkpoint worker started"'),
  )
  if (readFileSync(logPath, "utf8").includes('"msg":"WAL checkpoint worker failed;'))
    throw new Error("Compiled checkpoint worker entered fallback")
  const { port, token } = JSON.parse(readFileSync(handshakePath, "utf8"))
  const api = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, Origin: "tauri://localhost", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) throw new Error(`Fixture API failed: ${path} (${response.status})`)
    return response.json() as Promise<T>
  }
  await wait(async () => {
    try {
      await api("/machines")
      return true
    } catch {
      return false
    }
  })
  const { bot } = await api<{ bot: { id: string; machine: string; mainThreadId: string } }>("/bots", {
    name: "Platform fixture",
    provider: "codex",
    machine: "local",
    browserEnabled: false,
    computerUse: false,
    access: "read-only",
  })
  if (bot.machine !== "local") throw new Error("Local bot fixture was not created")
  const sent = await api<{ run: { id: string } }>(`/bots/${bot.id}/messages`, {
    text: "Return the fixture reply",
    sendId: "compiled-platform-fixture",
  })
  await wait(async () => {
    const { runs } = await api<{ runs: Array<{ id: string; status: string }> }>(`/threads/${bot.mainThreadId}/runs`)
    const run = runs.find((value: { id: string }) => value.id === sent.run.id)
    if (run && ["failed", "canceled", "interrupted"].includes(run.status))
      throw new Error(`Inert provider fixture failed (${run.status})`)
    return run?.status === "succeeded"
  })
  const { messages } = await api<{ messages: Array<{ role: string; text?: string }> }>(
    `/threads/${bot.mainThreadId}/messages`,
  )
  if (
    !messages.some(
      (message: { role: string; text?: string }) =>
        message.role === "assistant" && message.text?.includes("Compiled platform fixture reply"),
    )
  )
    throw new Error("Fixture reply was not persisted")
  console.log("Compiled sidecar smoke passed: local bot, persisted inert-provider reply, machine capability API")
} catch (error) {
  console.error(error)
  if (existsSync(join(root, "stderr.log"))) console.error(readFileSync(join(root, "stderr.log"), "utf8").slice(-4000))
  process.exitCode = 1
} finally {
  if (windows) child.stdin.end()
  else child.kill("SIGTERM")
  // The sidecar's own shutdown deadline is 10 seconds.
  await Promise.race([child.exited, Bun.sleep(12_000)])
  if (child.exitCode === null) {
    child.kill("SIGKILL")
    await child.exited
    console.error("Compiled sidecar did not shut down cleanly within its deadline")
    process.exitCode = 1
  } else if (child.exitCode !== 0) {
    console.error(`Compiled sidecar shutdown exited with code ${child.exitCode}`)
    process.exitCode = 1
  }
  await removeSmokeDirectory(root)
}
