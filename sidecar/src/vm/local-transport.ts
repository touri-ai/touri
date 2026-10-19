import { randomBytes } from "node:crypto"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { authorizeGatewayRequest, withoutCapabilityCookies } from "./gateway-session"

export const privateSocket = async (platform = process.platform) => {
  const directory = await mkdtemp(join(tmpdir(), "touri-channel-"))
  if (platform !== "win32") await chmod(directory, 0o700)
  return {
    path: platform === "win32" ? `\\\\.\\pipe\\touri-channel-${randomBytes(32).toString("hex")}` : join(directory, "s"),
    remove: () => rm(directory, { recursive: true, force: true }),
  }
}

export const trustedGatewayOrigin = (origin: string | null, host: string) =>
  origin === null ||
  ["tauri://localhost", "http://tauri.localhost", "http://localhost:1420", `http://${host}`].includes(origin)

const forwardedHeader = (line: string): string[] => {
  if (/^connection:/i.test(line)) return []
  if (!/^cookie:/i.test(line)) return [line]
  const remaining = withoutCapabilityCookies(line.slice(line.indexOf(":") + 1))
  return remaining ? [`Cookie: ${remaining}`] : []
}

/** A capability is scoped to this listener and removed before forwarding any bytes. */
export const capabilityListener = async (connect: (socket: Socket, initial?: Buffer) => void, hostPort = 0) => {
  const capability = randomBytes(32).toString("hex")
  const prefix = `/touri/${capability}`
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => socket.destroy())
    socket.setTimeout(5000, () => socket.destroy())
    let buffer = Buffer.alloc(0)
    const authenticate = (bytes: Buffer) => {
      buffer = Buffer.concat([buffer, bytes])
      const end = buffer.indexOf("\r\n\r\n")
      if (end < 0) {
        if (buffer.length > 32_768) socket.destroy()
        return
      }
      if (end > 32_768) return socket.destroy()
      socket.pause()
      socket.removeListener("data", authenticate)
      const lines = buffer.subarray(0, end).toString("latin1").split("\r\n")
      const request = lines.shift()?.match(/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (\/\S*) HTTP\/1\.[01]$/)
      const headers = new Map<string, string>()
      let valid = true
      for (const line of lines) {
        const at = line.indexOf(":")
        const key = line.slice(0, at).toLowerCase()
        if (at < 1 || headers.has(key) || /^\s/.test(line)) {
          valid = false
          break
        }
        headers.set(key, line.slice(at + 1).trim())
      }
      const host = `127.0.0.1:${(server.address() as { port: number }).port}`
      const decision =
        valid && request && headers.get("host") === host && trustedGatewayOrigin(headers.get("origin") ?? null, host)
          ? authorizeGatewayRequest({
              target: request[2] ?? "",
              capability,
              port: Number(host.split(":")[1]),
              cookie: headers.get("cookie") ?? null,
              fetchSite: headers.get("sec-fetch-site") ?? null,
            })
          : ({ action: "deny" } as const)
      if (decision.action === "session") {
        socket.end(
          `HTTP/1.1 302 Found\r\nLocation: ${decision.location}\r\nSet-Cookie: ${decision.setCookie}\r\nCache-Control: no-store\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
        )
        return
      }
      if (decision.action === "deny" || !request) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
        return
      }
      const route = decision.route
      socket.setTimeout(0)
      // Prevent a second unauthenticated HTTP request on a pooled connection.
      // WebSocket upgrades stay open; ordinary requests close after their response.
      const upgrade = headers.get("upgrade")?.toLowerCase() === "websocket"
      const body = buffer.subarray(end + 4)
      const declared = headers.get("content-length") ?? "0"
      if (
        !upgrade &&
        (!/^\d+$/.test(declared) ||
          headers.has("transfer-encoding") ||
          Number(declared) > 33_554_432 ||
          body.length > Number(declared))
      )
        return socket.destroy()
      let remaining = Number(declared) - body.length
      if (!upgrade)
        socket.on("data", (bytes) => {
          remaining -= bytes.length
          if (remaining < 0) socket.destroy()
        })
      const outgoing = [
        `${request[1]} ${route} HTTP/1.1`,
        ...lines.flatMap((line) => forwardedHeader(line)),
        `Connection: ${upgrade ? "Upgrade" : "close"}`,
        "",
        "",
      ].join("\r\n")
      connect(socket, Buffer.concat([Buffer.from(outgoing, "latin1"), body]))
      socket.resume()
    }
    socket.on("data", authenticate)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(hostPort, "127.0.0.1", resolve)
  })
  const port = (server.address() as { port: number }).port
  return {
    server,
    hostPort: port,
    url: `http://127.0.0.1:${port}${prefix}`,
    close: () => {
      for (const socket of sockets) socket.destroy()
      server.close()
    },
  }
}
