import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { buildChildEnv } from "../../src/kernel/shell-env"

const lifecycle = resolve(import.meta.dir, "../../src/kernel/lifecycle.ts")
const fixture = `import { watchShutdownRequest } from ${JSON.stringify(lifecycle)}
watchShutdownRequest(() => { process.stdout.write("shutdown\\n"); process.exit(0) })
process.stdout.write("ready\\n")
await Bun.sleep(30_000)
process.exit(7)`

const start = (flag: string | undefined) => {
  const env = buildChildEnv()
  if (flag === undefined) delete env.TOURI_SHUTDOWN_ON_STDIN_EOF
  else env.TOURI_SHUTDOWN_ON_STDIN_EOF = flag
  return Bun.spawn({ cmd: [process.execPath, "-e", fixture], env, stdin: "pipe", stdout: "pipe", stderr: "ignore" })
}

const readLine = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader()
  let text = ""
  while (!text.includes("\n")) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += new TextDecoder().decode(chunk.value)
  }
  reader.releaseLock()
  return text.trim()
}

test("closing stdin asks the sidecar for a clean shutdown when the shell enables it", async () => {
  const child = start("1")
  expect(await readLine(child.stdout)).toBe("ready")
  await Bun.sleep(300)
  expect(child.exitCode).toBeNull()
  child.stdin.end()
  expect(await Promise.race([child.exited, Bun.sleep(10_000).then(() => "timeout")])).toBe(0)
  expect(await readLine(child.stdout)).toBe("shutdown")
}, 30_000)

test("without the shell flag, closing stdin does not stop the sidecar", async () => {
  const child = start(undefined)
  try {
    expect(await readLine(child.stdout)).toBe("ready")
    child.stdin.end()
    await Bun.sleep(500)
    expect(child.exitCode).toBeNull()
  } finally {
    child.kill()
    await child.exited
  }
}, 30_000)
