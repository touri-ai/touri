import { createConnection, type Socket } from "node:net"
import { MCP_LIMITS } from "../mcp/connection"

/** Idle host connections the guest bridge keeps ready for new MCP clients. */
export const BRIDGE_IDLE_POOL = 4

// Connect outward through a localhost guest port, then relay the original authenticated MCP protocol.
// An idle connection waits for the guest to pair it with a client, which may take any time. Closing it
// on a timer races that pairing (the guest pairs it while the host drops it) and, when forwarding is
// slower than the timer, keeps the guest pool empty. Only connecting and a started reply are timed.
export const connectMcpBridge = ({
  port,
  token,
  socketPath,
  transport,
}: {
  transport?: string
  port: number
  token: string
  socketPath: string
}): (() => void) => {
  let stopped = false
  let idle = 0
  let hosts = 0
  const sockets = new Set<Socket>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const fill = () => {
    while (!stopped && idle < BRIDGE_IDLE_POOL && hosts < MCP_LIMITS.connections) connect()
  }
  const refill = () => {
    if (stopped) return
    const timer = setTimeout(() => {
      timers.delete(timer)
      fill()
    }, 200)
    timers.add(timer)
  }
  const connect = () => {
    idle++
    hosts++
    let waiting = true
    const socket = createConnection(
      transport?.startsWith("unix:") ? { path: transport.slice(5) } : { host: "127.0.0.1", port },
    )
    let deadline: ReturnType<typeof setTimeout> | null = setTimeout(() => socket.destroy(), MCP_LIMITS.authMs)
    deadline.unref()
    const settle = () => {
      if (deadline) clearTimeout(deadline)
      deadline = null
    }
    const leaveIdle = () => {
      if (!waiting) return
      waiting = false
      idle--
    }
    sockets.add(socket)
    socket.once("connect", () => {
      settle()
      socket.write(`${JSON.stringify({ role: "host", token })}\n`)
    })
    let buffer = Buffer.alloc(0)
    const paired = (chunk: Buffer) => {
      if (buffer.length + chunk.length > MCP_LIMITS.frameBytes + 100) return socket.destroy()
      buffer = Buffer.concat([buffer, chunk])
      if (!deadline) {
        deadline = setTimeout(() => socket.destroy(), MCP_LIMITS.authMs)
        deadline.unref()
      }
      const newline = buffer.indexOf(10)
      if (newline < 0) {
        if (buffer.length > 100) socket.destroy()
        return
      }
      socket.pause()
      socket.removeListener("data", paired)
      if (buffer.subarray(0, newline).toString() !== "paired") return socket.destroy()
      leaveIdle()
      fill()
      const upstream = createConnection(socketPath)
      sockets.add(upstream)
      upstream.on("error", () => socket.destroy())
      upstream.on("close", () => {
        sockets.delete(upstream)
        socket.destroy()
      })
      socket.on("close", () => upstream.destroy())
      upstream.once("connect", () => {
        settle()
        if (buffer.length > newline + 1) upstream.write(buffer.subarray(newline + 1))
        upstream.pipe(socket)
        socket.pipe(upstream)
        socket.resume()
      })
    }
    socket.on("data", paired)
    socket.on("error", () => socket.destroy())
    socket.on("close", () => {
      settle()
      sockets.delete(socket)
      leaveIdle()
      hosts--
      refill()
    })
  }
  fill()
  return () => {
    stopped = true
    for (const timer of timers) clearTimeout(timer)
    for (const socket of sockets) socket.destroy()
  }
}
