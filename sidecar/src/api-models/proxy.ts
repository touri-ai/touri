import { randomUUID } from "node:crypto"
import type { ApiModel, StartTurnArgs } from "@touri/contracts"
import { startLineReader } from "../runtime/provider-io"
import { getApiError } from "./client"

type ProxyOptions = {
  baseUrl: string
  key: string
  token: string
  mapError: (status: number, detail: string) => string
  fetchImpl?: typeof fetch
}

/** Keep provider credentials and raw error bodies outside the executor's persistent session. */
export const startApiModelProxy = async ({
  model,
  key,
  args,
  root,
  write,
  signal,
}: {
  model: ApiModel
  key: string
  args: StartTurnArgs
  root: string
  write: (file: { path: string; content: string }) => Promise<void>
  signal: AbortSignal
}): Promise<{ url: string; token: string; close: () => Promise<void> }> => {
  const token = randomUUID()
  const options = { baseUrl: model.baseUrl, key, token, mapError: getApiError }
  if (!args.execution) {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => forwardApiRequest(request, options),
    })
    return { url: `http://127.0.0.1:${server.port}/v1`, token, close: async () => server.stop(true) }
  }

  const path = `${root}/api-proxy.cjs`
  await write({ path, content: getApiProxyProgram() })
  const child = args.execution.spawn({
    cmd: args.mcp.command,
    args: [path],
    cwd: args.fingerprint.cwd,
    env: Object.assign({}, args.env, {
      TOURI_API_UPSTREAM: model.baseUrl,
      TOURI_API_SECRET: key,
      TOURI_API_TOKEN: token,
    }),
  })
  if (!child.success) throw new Error("Could not start the private API transport")
  const close = async () => {
    child.kill("SIGKILL")
    await child.exited
    signal.removeEventListener("abort", abort)
  }
  const abort = () => void close()
  signal.addEventListener("abort", abort, { once: true })
  try {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    // The reader is installed before the process can announce its listening port.
    let stop = () => {}
    const url = await new Promise<string>((resolve, reject) => {
      const finish = (url: string) => {
        stop()
        deadline.removeEventListener("abort", cancel)
        resolve(url)
      }
      const cancel = () => {
        stop()
        reject(new Error("Private API transport did not start"))
      }
      stop = startLineReader({
        stream: child.stdout,
        onLine: (line) => {
          const match = line.match(/^TOURI_API_PROXY=(\d+)$/)
          if (match) finish(`http://127.0.0.1:${match[1]}/v1`)
        },
        onError: () => reject(new Error("Private API transport did not start")),
      })
      void child.exited.then(() => reject(new Error("Private API transport stopped")))
      deadline.addEventListener("abort", cancel, { once: true })
      if (deadline.aborted) cancel()
    })
    return { url, token, close }
  } catch (error) {
    await close()
    throw error
  }
}

/** Self-contained so the same response boundary can run inside an isolated machine. */
export const forwardApiRequest = async (request: Request, options: ProxyOptions): Promise<Response> => {
  if (
    request.method !== "POST" ||
    new URL(request.url).pathname !== "/v1/chat/completions" ||
    request.headers.get("Authorization") !== `Bearer ${options.token}`
  )
    return new Response(null, { status: 403 })

  try {
    const response = await (options.fetchImpl ?? fetch)(`${options.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.key}`, "Content-Type": "application/json" },
      body: request.body,
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(300_000)]),
      duplex: "half",
    } as RequestInit)
    if (!response.ok) {
      const reason = options.mapError(response.status, (await response.text()).slice(0, 65_536))
      return Response.json({ error: { message: reason } }, { status: response.status })
    }

    const secrets = Array.from(
      new Set([options.key, encodeURIComponent(options.key), JSON.stringify(options.key).slice(1, -1)]),
    )
    const keep = secrets.reduce((longest, secret) => Math.max(longest, secret.length), 0)
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    // Retain a suffix between chunks so split credentials cannot reach session storage.
    let pending = ""
    const redact = (text: string) => secrets.reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), text)
    const stream = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const text = redact(pending + decoder.decode(chunk, { stream: true }))
        const end = Math.max(0, text.length - keep)
        controller.enqueue(encoder.encode(text.slice(0, end)))
        pending = text.slice(end)
      },
      flush(controller) {
        controller.enqueue(encoder.encode(redact(pending + decoder.decode())))
      },
    })
    return new Response(response.body?.pipeThrough(stream) ?? null, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type")?.includes("text/event-stream")
          ? "text/event-stream"
          : "application/json",
      },
    })
  } catch {
    return Response.json({ error: { message: "unavailable" } }, { status: 503 })
  }
}

export const getApiProxyProgram = (): string => `
const { createServer } = require("node:http")
const { Readable } = require("node:stream")
const handle = ${forwardApiRequest.toString()}
const mapError = ${getApiError.toString()}
const options = {
  baseUrl: process.env.TOURI_API_UPSTREAM,
  key: process.env.TOURI_API_SECRET,
  token: process.env.TOURI_API_TOKEN,
  mapError,
}
const server = createServer(async (request, response) => {
  try {
    const input = new Request("http://127.0.0.1" + request.url, {
      method: request.method,
      headers: request.headers,
      body: request.method === "POST" ? Readable.toWeb(request) : undefined,
      duplex: "half",
    })
    const result = await handle(input, options)
    response.writeHead(result.status, Object.fromEntries(result.headers))
    if (!result.body) return response.end()
    const output = Readable.fromWeb(result.body)
    response.on("close", () => output.destroy())
    output.on("error", () => response.destroy())
    output.pipe(response)
  } catch {
    response.writeHead(503).end()
  }
})
server.listen(0, "127.0.0.1", () => console.log("TOURI_API_PROXY=" + server.address().port))
`
