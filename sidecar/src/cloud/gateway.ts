import { randomBytes } from "node:crypto"
import { createServer } from "node:net"
import { authorizeGatewayRequest } from "../vm/gateway-session"
import { privateSocket, trustedGatewayOrigin } from "../vm/local-transport"
import type { CloudClient } from "./client"
import { CloudError } from "./client"

const ready = (socket: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new CloudError("TOURI-E9000")), { once: true })
    socket.addEventListener("close", () => reject(new CloudError("TOURI-E9001")), { once: true })
  })

/** Binary WS ↔ private loopback TCP, for RFB and explicitly granted PTY channels. */
export const tcpGateway = async (client: CloudClient, path: string) => {
  let closed = false
  const privateChannel = await privateSocket()
  const sockets = new Set<WebSocket>()
  const connections = new Set<import("node:net").Socket>()
  const server = createServer((local) => {
    if (closed) return local.destroy()
    connections.add(local)
    let upstream: WebSocket | undefined
    const close = () => {
      local.destroy()
      upstream?.close()
      connections.delete(local)
      if (upstream) sockets.delete(upstream)
    }
    local.pause()
    local.on("error", close)
    local.on("close", close)
    void (async () => {
      upstream = await client.socket(path)
      if (closed || local.destroyed) {
        upstream.close()
        return
      }
      sockets.add(upstream)
      upstream.binaryType = "arraybuffer"
      upstream.addEventListener("message", ({ data }) => {
        if (!(data instanceof ArrayBuffer) || data.byteLength > 1_048_576) return close()
        local.write(Buffer.from(data))
        if (local.writableLength > 1_048_576) close()
      })
      upstream.addEventListener("close", close)
      upstream.addEventListener("error", close)
      await ready(upstream)
      const socket = upstream
      local.on("data", (bytes) => {
        if (socket.bufferedAmount > 1_048_576) close()
        else socket.send(bytes)
      })
      local.resume()
    })().catch(close)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(privateChannel.path, resolve)
  })
  const address = server.address()
  if (!address) throw new CloudError("TOURI-E9000")
  return {
    hostPort: 0,
    url: `unix:${privateChannel.path}`,
    close: () => {
      closed = true
      for (const socket of sockets) socket.close()
      for (const local of connections) local.destroy()
      server.close()
      void privateChannel.remove().catch(() => {})
    },
  }
}

/** The renderer only receives this loopback proxy; credentials stay in the sidecar. */
export const httpGateway = (client: CloudClient, path: string, fence: { generation: number; expiresAt: string }) => {
  let closed = false
  const capability = randomBytes(32).toString("hex")
  const prefix = `/touri/${capability}`
  const peers = new Set<WebSocket>()
  const server = Bun.serve<{ remote: string; upstream?: WebSocket }>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, server) {
      if (closed || Date.parse(fence.expiresAt) <= Date.now()) return new Response(null, { status: 409 })
      const local = new URL(req.url)
      const host = `127.0.0.1:${server.port}`
      const decision =
        req.headers.get("host") === host && trustedGatewayOrigin(req.headers.get("origin"), host)
          ? authorizeGatewayRequest({
              target: `${local.pathname}${local.search}`,
              capability,
              port: server.port ?? 0,
              cookie: req.headers.get("cookie"),
              fetchSite: req.headers.get("sec-fetch-site"),
            })
          : ({ action: "deny" } as const)
      if (decision.action === "session")
        return new Response(null, {
          status: 302,
          headers: { Location: decision.location, "Set-Cookie": decision.setCookie, "Cache-Control": "no-store" },
        })
      if (decision.action === "deny") return new Response(null, { status: 403 })
      const remote = client.endpoint(`${path}${decision.route}`)
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const ws = new URL(remote)
        ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:"
        ws.searchParams.set("generation", String(fence.generation))
        if (server.upgrade(req, { data: { remote: ws.toString() } })) return
        return new Response(null, { status: 400 })
      }
      if (req.method !== "GET") return new Response(null, { status: 405 })
      try {
        const response = await fetch(remote, {
          redirect: "error",
          headers: {
            Authorization: `Bearer ${await client.access()}`,
            "Touri-Cloud-Version": "1",
            "Touri-Machine-Generation": String(fence.generation),
          },
          signal: AbortSignal.timeout(30_000),
        })
        if (response.headers.get("content-type")?.includes("application/json")) {
          const rewrite = (value: unknown): unknown => {
            if (Array.isArray(value)) return value.map(rewrite)
            if (value && typeof value === "object")
              return Object.fromEntries(
                Object.entries(value).map(([key, item]) => [
                  key,
                  key === "webSocketDebuggerUrl" && typeof item === "string"
                    ? `ws://127.0.0.1:${server.port}${prefix}${new URL(client.endpoint(item, true)).pathname.slice(new URL(path).pathname.length)}${new URL(item).search}`
                    : rewrite(item),
                ]),
              )
            return value
          }
          return Response.json(rewrite(await response.json()), { status: response.status })
        }
        return new Response(response.body, {
          status: response.status,
          headers: { "Content-Type": response.headers.get("content-type") ?? "application/octet-stream" },
        })
      } catch {
        return new Response(null, { status: 502 })
      }
    },
    websocket: {
      async open(local) {
        try {
          const upstream = await client.socket(local.data.remote)
          if (closed || local.readyState !== 1) {
            upstream.close()
            return
          }
          local.data.upstream = upstream
          peers.add(upstream)
          upstream.binaryType = "arraybuffer"
          upstream.addEventListener("message", ({ data }) => {
            if (local.send(data) === 0) local.close()
          })
          upstream.addEventListener("close", () => local.close())
          upstream.addEventListener("error", () => local.close())
          await ready(upstream)
        } catch {
          local.close(1011)
        }
      },
      message(local, bytes) {
        const upstream = local.data.upstream
        if (upstream?.readyState !== 1 || upstream.bufferedAmount > 1_048_576) return local.close(1013)
        upstream.send(bytes)
      },
      close(local) {
        local.data.upstream?.close()
        if (local.data.upstream) peers.delete(local.data.upstream)
      },
    },
  })
  return {
    hostPort: server.port ?? 0,
    url: `http://127.0.0.1:${server.port}${prefix}`,
    close: () => {
      closed = true
      for (const peer of peers) peer.close()
      server.stop(true)
    },
  }
}
