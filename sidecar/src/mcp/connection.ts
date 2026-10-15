import type { Socket } from "node:net"
import type { Kernel, ToolRegistration, ToolResult } from "@touri/contracts"
import { touriVersion } from "../version"
import { authenticateMcp, type McpCallerContext } from "./auth"
import { isJsonRpcRequest, type JsonRpcRequest, type JsonRpcResponse, parseJsonRpcRequest } from "./protocol"
import { redactMcpValue } from "./redact"
import { createToolRouter } from "./router"
import { watchMcpToken } from "./run-token"

type JsonObject = Record<string, unknown>
export const MCP_LIMITS = {
  frameBytes: 256 * 1024,
  authBytes: 4096,
  queued: 8,
  connections: 32,
  authMs: 5000,
  readMs: 30_000,
  writeBytes: 8 * 1024 * 1024,
  writeMs: 10_000,
}

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null

const send = (socket: Socket, message: JsonRpcResponse): void => {
  if (socket.destroyed || socket.writableEnded) return
  const frame = `${JSON.stringify(message)}\n`
  if (Buffer.byteLength(frame) + socket.writableLength > MCP_LIMITS.writeBytes) {
    socket.destroy()
    return
  }
  if (!socket.write(frame)) socket.pause()
}

const response = (id: JsonRpcResponse["id"], result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result })

const requestKey = (id: string | number | null): string => `${typeof id}:${String(id)}`

const rpcError = (id: JsonRpcResponse["id"], code: number, message: string): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
})

const asParams = (params: unknown): JsonObject => (isObject(params) ? params : {})

const isPlainRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const asStructuredContent = (value: unknown): JsonObject => (isPlainRecord(value) ? value : { result: value })

const asToolResult = (result: ToolResult, redact: (text: string) => string): Record<string, unknown> => {
  const content = result.content ?? []
  const safeContent = content.map((item) => (item.type === "text" ? { ...item, text: redact(item.text) } : item))
  if (result.success) {
    const output: Record<string, unknown> = { content: safeContent, isError: false }
    if (result.structured !== undefined)
      output.structuredContent = asStructuredContent(redactMcpValue(result.structured, redact))
    return output
  }
  return {
    content: [{ type: "text", text: `ERROR ${result.errorCode}: ${redact(result.error)}` }, ...safeContent],
    isError: true,
  }
}

const initializeResult = (request: JsonRpcRequest): Record<string, unknown> => {
  const params = asParams(request.params)
  const requested = params.protocolVersion
  return {
    protocolVersion: typeof requested === "string" ? requested : "2024-11-05",
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "touri", version: touriVersion },
  }
}

export const serveMcpConnection = ({
  socket,
  kernel,
  tokenDir,
  registrations,
  deadlines = {},
}: {
  socket: Socket
  kernel: Kernel
  tokenDir: string
  registrations: Map<string, ToolRegistration>
  deadlines?: { authMs?: number; readMs?: number; writeMs?: number }
}): void => {
  const router = createToolRouter({ kernel, registrations })
  const connectionAbort = new AbortController()
  let authenticated: McpCallerContext | null = null
  let authLine = ""
  let unwatch: (() => void) | undefined
  let buffer = ""
  let queue = Promise.resolve()
  let queued = 0
  let authQueued = false
  const inflight = new Map<string, AbortController>()
  let active = 0
  let waitingForDrain = false
  let readTimer: ReturnType<typeof setTimeout> | undefined
  const authTimer = setTimeout(() => socket.destroy(), deadlines.authMs ?? MCP_LIMITS.authMs)
  authTimer.unref()
  let writeTimer: ReturnType<typeof setTimeout> | undefined
  const resume = () => {
    if (!socket.destroyed && queued < MCP_LIMITS.queued / 2 && !waitingForDrain) socket.resume()
  }
  socket.on("drain", () => {
    waitingForDrain = false
    clearTimeout(writeTimer)
    resume()
  })

  socket.setEncoding("utf8")
  socket.setNoDelay(true)
  socket.on("error", () => connectionAbort.abort())
  socket.on("close", () => {
    clearTimeout(authTimer)
    clearTimeout(readTimer)
    clearTimeout(writeTimer)
    buffer = ""
    unwatch?.()
    connectionAbort.abort()
  })

  const runToolCall = async ({
    request,
    name,
    args,
    caller,
  }: {
    request: JsonRpcRequest
    name: string
    args: unknown
    caller: McpCallerContext
  }): Promise<void> => {
    const requestId = request.id ?? null
    const key = requestKey(requestId)
    const controller = new AbortController()
    const forwardAbort = (): void => controller.abort()
    connectionAbort.signal.addEventListener("abort", forwardAbort, { once: true })
    active++
    inflight.set(key, controller)
    try {
      const result = await router.call({
        id: requestId,
        name,
        args: args === undefined ? {} : args,
        caller,
        signal: controller.signal,
      })
      if (isJsonRpcRequest(request) && !connectionAbort.signal.aborted)
        send(socket, response(requestId, asToolResult(result, kernel.redact)))
    } catch {
      socket.destroy()
    } finally {
      connectionAbort.signal.removeEventListener("abort", forwardAbort)
      active--
      if (inflight.get(key) === controller) inflight.delete(key)
    }
  }

  const handleLine = async (line: string): Promise<void> => {
    if (line.length === 0) return
    if (!authenticated) {
      const auth = authenticateMcp({ line, tokenDir, database: kernel.db as import("bun:sqlite").Database, kernel })
      if (!auth.success) {
        socket.destroy()
        return
      }
      authenticated = auth.caller
      clearTimeout(authTimer)
      authLine = line
      unwatch = watchMcpToken(kernel, auth.tokenPath, () => {
        connectionAbort.abort()
        socket.destroy()
      })
      return
    }

    // Revalidate queued requests too; release fences an already connected client.
    const auth = authenticateMcp({
      line: authLine,
      tokenDir,
      database: kernel.db as import("bun:sqlite").Database,
      kernel,
    })
    if (connectionAbort.signal.aborted || !auth.success) {
      connectionAbort.abort()
      socket.destroy()
      return
    }
    authenticated = auth.caller

    const request = parseJsonRpcRequest(line)
    if (!request) {
      send(socket, rpcError(null, -32700, "Parse error"))
      return
    }
    const requestId = request.id ?? null
    if (request.method === "notifications/initialized") return
    if (request.method === "notifications/cancelled") {
      const cancelled = asParams(request.params).requestId
      if (typeof cancelled === "string" || typeof cancelled === "number") inflight.get(requestKey(cancelled))?.abort()
      return
    }
    if (request.method === "initialize") {
      if (isJsonRpcRequest(request)) send(socket, response(requestId, initializeResult(request)))
      return
    }
    if (request.method === "ping") {
      if (isJsonRpcRequest(request)) send(socket, response(requestId, {}))
      return
    }
    if (request.method === "tools/list") {
      if (isJsonRpcRequest(request))
        send(socket, response(requestId, { tools: router.list({ caller: authenticated }) }))
      return
    }
    if (request.method === "tools/call") {
      if (active >= MCP_LIMITS.queued) {
        socket.destroy()
        return
      }
      if (request.id === undefined || request.id === null || inflight.has(requestKey(request.id))) {
        send(socket, rpcError(requestId, -32600, "Invalid Request: tools/call needs a unique request id"))
        return
      }
      const params = asParams(request.params)
      const name = params.name
      const args = params.arguments
      if (typeof name !== "string") {
        if (isJsonRpcRequest(request))
          send(
            socket,
            response(
              requestId,
              asToolResult(
                { success: false, errorCode: "INVALID_ARGS", error: "Tool name is required" },
                kernel.redact,
              ),
            ),
          )
        return
      }
      void runToolCall({ request, name, args, caller: authenticated })
      return
    }
    if (isJsonRpcRequest(request)) send(socket, rpcError(requestId, -32601, `Method not found: ${request.method}`))
  }

  socket.on("data", (chunk: string) => {
    if (socket.destroyed) return
    // Include a bounded batch of complete frames, and never concatenate an endless line.
    if (Buffer.byteLength(chunk) + Buffer.byteLength(buffer) > MCP_LIMITS.frameBytes * MCP_LIMITS.queued) {
      socket.destroy()
      return
    }
    buffer += chunk
    let newline = buffer.indexOf("\n")
    while (newline >= 0) {
      if (
        Buffer.byteLength(buffer.slice(0, newline)) >
          (authenticated || authQueued ? MCP_LIMITS.frameBytes : MCP_LIMITS.authBytes) ||
        queued >= MCP_LIMITS.queued
      ) {
        socket.destroy()
        return
      }
      const line = buffer.slice(0, newline).trim()
      if (line.length > 0) authQueued = true
      buffer = buffer.slice(newline + 1)
      queued++
      if (queued >= MCP_LIMITS.queued / 2) socket.pause()
      queue = queue
        .then(() => (socket.destroyed ? undefined : handleLine(line)))
        .catch(() => {
          socket.destroy()
        })
        .finally(() => {
          queued--
          if (socket.writableNeedDrain && !waitingForDrain) {
            waitingForDrain = true
            writeTimer = setTimeout(() => socket.destroy(), deadlines.writeMs ?? MCP_LIMITS.writeMs)
          }
          resume()
        })
      newline = buffer.indexOf("\n")
    }
    if (Buffer.byteLength(buffer) > (authenticated || authQueued ? MCP_LIMITS.frameBytes : MCP_LIMITS.authBytes)) {
      socket.destroy()
      return
    }
    if (!buffer.length) {
      clearTimeout(readTimer)
      readTimer = undefined
    } else if (!readTimer) {
      readTimer = setTimeout(() => socket.destroy(), deadlines.readMs ?? MCP_LIMITS.readMs)
      readTimer.unref()
    }
  })
}
