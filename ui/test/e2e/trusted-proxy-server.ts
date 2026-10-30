import { type ChildProcess, spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "../../..")
export const trustedProxyHeaders = {
  "x-forwarded-email": "owner@example.test",
  "x-touri-proxy-secret": "synthetic-proxy-secret-for-browser-tests-only",
}

export const createTrustedProxyServer = async ({ baselineRoot }: { baselineRoot?: string } = {}) => {
  const port = await getAvailablePort()
  const directory = await mkdtemp(join(tmpdir(), "touri-proxy-signin-"))
  const secretFile = join(directory, "proxy-secret")
  await writeFile(secretFile, trustedProxyHeaders["x-touri-proxy-secret"], { mode: 0o600 })
  const child = spawn(
    "bun",
    [
      "sidecar/src/cli/main.ts",
      "serve",
      "--port",
      String(port),
      "--data-dir",
      directory,
      "--ui-dir",
      join(root, "ui/dist"),
      "--trust-proxy",
      ...(baselineRoot
        ? []
        : [
            "--trust-proxy-email",
            "X-Forwarded-Email",
            "--trust-proxy-secret-file",
            secretFile,
            "--owner-email",
            "owner@example.test",
          ]),
    ],
    {
      cwd: baselineRoot ?? root,
      env: { ...process.env, TOURI_APP_DATA: directory, TOURI_DOCTOR_SKIP_PROVIDER_PROBES: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  const dispose = async () => {
    await stop(child)
    await rm(directory, { recursive: true, force: true })
  }

  child.stderr?.resume()
  try {
    await waitForServer(child)
  } catch (error) {
    await dispose()
    throw error
  }

  return { url: `http://127.0.0.1:${port}`, dispose }
}

const getAvailablePort = async (offset = Math.floor(Math.random() * 100), remaining = 100): Promise<number> => {
  if (remaining === 0) throw new Error("No synthetic server port available")
  const port = 18800 + offset
  const listener = createServer()
  const available = await new Promise<boolean>((done, reject) => {
    listener.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") return done(false)
      reject(error)
    })
    listener.listen(port, "127.0.0.1", () => done(true))
  })
  if (!available) return getAvailablePort((offset + 1) % 100, remaining - 1)
  await new Promise<void>((done, reject) => listener.close((error) => (error ? reject(error) : done())))

  return port
}

const waitForServer = (child: ChildProcess) =>
  new Promise<void>((done, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout)
      child.stdout?.off("data", onOutput)
      child.off("exit", onExit)
      child.off("error", finish)
      if (error) return reject(error)
      done()
    }
    const onOutput = (chunk: Buffer) => {
      if (chunk.toString().includes("listening on")) finish()
    }
    const onExit = () => finish(new Error("Synthetic proxy server exited"))
    const timeout = setTimeout(() => finish(new Error("Synthetic proxy server startup timed out")), 60_000)
    child.stdout?.on("data", onOutput)
    child.once("exit", onExit)
    child.once("error", finish)
  })

const stop = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return

  await new Promise<void>((done) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000)
    child.once("exit", () => {
      clearTimeout(timeout)
      done()
    })
    child.kill("SIGTERM")
  })
}
