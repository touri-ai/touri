import { createConnection, type Socket } from "node:net"
import type { HostMethods, HostNotification, Kernel } from "@touri/contracts"

type RpcResponse = { id?: number; result?: unknown; error?: { message?: string } }
type Pending = { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }

type HostErrorCode = "HOST_ERROR" | "VAULT_ACCESS_REQUIRED" | "VAULT_TIMEOUT" | "VAULT_CANCELLED" | "VAULT_UNAVAILABLE"
const hostErrorCode = (message?: string): HostErrorCode => {
  switch (message) {
    case "VAULT_ACCESS_REQUIRED":
    case "VAULT_TIMEOUT":
    case "VAULT_CANCELLED":
    case "VAULT_UNAVAILABLE":
      return message
    default:
      return "HOST_ERROR"
  }
}

const record = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "object" || value === null) return null
  return value as Record<string, unknown>
}

export const createHostClient = ({
  socketPath,
  token,
  onNotification,
}: {
  socketPath: string
  token: string
  onNotification: (notification: HostNotification) => void
}) => {
  let socket: Socket | null = null
  let connecting: Promise<Socket> | null = null
  let nextId = 1
  let buffer = ""
  const pending = new Map<number, Pending>()

  const failConnection = (error: Error): void => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    socket?.destroy()
    socket = null
    connecting = null
    buffer = ""
  }

  const receive = (chunk: Buffer): void => {
    buffer += chunk.toString("utf8")
    let newline = buffer.indexOf("\n")
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf("\n")
      if (!line) continue
      try {
        const parsed: unknown = JSON.parse(line)
        const message = record(parsed)
        if (!message) continue
        if (typeof message.id === "number") {
          const request = pending.get(message.id)
          if (request) {
            pending.delete(message.id)
            request.resolve(message as RpcResponse)
          }
        } else if (typeof message.method === "string") {
          onNotification(message as unknown as HostNotification)
        }
      } catch {
        failConnection(new Error("Invalid host bridge JSON-RPC frame"))
      }
    }
  }

  const request = (method: string, params: unknown): Promise<RpcResponse> =>
    new Promise((resolve, reject) => {
      if (!socket || socket.destroyed || socket.writableEnded) {
        reject(new Error("Host bridge is not connected"))
        return
      }
      const id = nextId++
      pending.set(id, { resolve, reject })
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })

  const connect = async (): Promise<Socket> => {
    if (socket) return socket
    if (connecting) return connecting
    connecting = new Promise<Socket>((resolve, reject) => {
      const candidate = createConnection(socketPath)
      const fail = (error: Error): void => {
        candidate.destroy()
        failConnection(error)
        reject(error)
      }
      candidate.once("error", fail)
      candidate.once("connect", async () => {
        candidate.off("error", fail)
        candidate.on("error", (error) => failConnection(error instanceof Error ? error : new Error(String(error))))
        candidate.on("data", receive)
        socket = candidate
        try {
          const auth = await request("auth", { token })
          if (auth.error) throw new Error(auth.error.message ?? "Host authentication failed")
          resolve(candidate)
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)))
        }
      })
      candidate.once("close", () => {
        if (socket === candidate) failConnection(new Error("Host bridge closed"))
      })
      candidate.once("end", () => {
        if (socket === candidate) failConnection(new Error("Host bridge ended"))
      })
    }).finally(() => {
      connecting = null
    })
    return connecting
  }

  const callHost: Kernel["callHost"] = async (method, params) => {
    try {
      await connect()
      const response = await request(method, params)
      if (response.error)
        return {
          success: false,
          errorCode: hostErrorCode(response.error.message),
          error: response.error.message ?? "Host error",
        }
      return { success: true, value: response.result as HostMethods[typeof method]["result"] }
    } catch (error) {
      return {
        success: false,
        errorCode: "HOST_UNAVAILABLE",
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const close = (): void => {
    failConnection(new Error("Host client closed"))
  }

  return { callHost, close }
}
