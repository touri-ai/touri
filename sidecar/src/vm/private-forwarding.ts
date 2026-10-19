import { createServer, type Socket } from "node:net"
import { capabilityListener, privateSocket } from "./local-transport"
import type { VmPortForward, VmProvider, VmResult } from "./types"

const validPort = (port: number): boolean => Number.isInteger(port) && port >= 1 && port <= 65535
const configuredPort = ({
  ports,
  guestPort,
  hostPort,
}: {
  ports: Map<number, VmPortForward>
  guestPort: number
  hostPort?: number
}): VmResult<VmPortForward> => {
  const configured = ports.get(guestPort)
  if (!configured)
    return {
      success: false,
      errorCode: "PORT_NOT_CONFIGURED",
      error: `Port ${guestPort} was not declared when the container was created; recreate it with ports[]`,
    }
  if (hostPort !== undefined && configured.hostPort !== hostPort)
    return {
      success: false,
      errorCode: "PORT_NOT_CONFIGURED",
      error: `Port ${guestPort} is forwarded to ${configured.hostPort}, not ${hostPort}`,
    }
  return { success: true, ...configured }
}

export const createPrivateForwarding = (provider: Pick<VmProvider, "spawn">) => {
  const portsByVm = new Map<string, Map<number, VmPortForward>>()
  const proxies = new Map<string, Map<number, { close: () => void }>>()
  const proxySockets = new Map<string, Set<Socket>>()
  const forgetVm = (id: string) => {
    for (const socket of proxySockets.get(id) ?? []) socket.destroy()
    proxySockets.delete(id)
    for (const server of proxies.get(id)?.values() ?? []) server.close()
    proxies.delete(id)
    portsByVm.delete(id)
  }
  return {
    portsByVm,
    forgetVm,
    async forwardPort({
      id,
      guestPort,
      hostPort,
    }: Parameters<VmProvider["forwardPort"]>[0]): Promise<VmResult<VmPortForward>> {
      if (!validPort(guestPort) || (hostPort !== undefined && !validPort(hostPort)))
        return { success: false, errorCode: "INVALID_CONFIG", error: "Invalid port" }
      const ports = portsByVm.get(id) ?? new Map<number, VmPortForward>()
      portsByVm.set(id, ports)
      if (ports.has(guestPort))
        return hostPort === undefined
          ? configuredPort({ ports, guestPort })
          : configuredPort({ ports, guestPort, hostPort })
      const relay = (socket: Socket, initial?: Buffer) => {
        const sockets = proxySockets.get(id) ?? new Set<Socket>()
        sockets.add(socket)
        proxySockets.set(id, sockets)
        socket.once("close", () => sockets.delete(socket))
        const child = provider.spawn({ id, command: "socat", args: ["STDIO", `TCP:127.0.0.1:${guestPort}`] })
        if (!child.success) return socket.destroy()
        const writer = child.stdin.getWriter()
        if (initial) void writer.write(initial).catch(() => socket.destroy())
        socket.on("data", (chunk) => {
          if (socket.destroyed) return
          socket.pause()
          void writer
            .write(chunk)
            .then(() => socket.resume())
            .catch(() => socket.destroy())
        })
        socket.on("error", () => socket.destroy())
        socket.on("close", () => {
          void writer.close().catch(() => {})
          child.kill("SIGTERM")
        })
        void child.stdout
          .pipeTo(
            new WritableStream({
              write: (chunk) =>
                new Promise<void>((resolve, reject) => {
                  socket.write(chunk, (error) => (error ? reject(error) : resolve()))
                }),
            }),
          )
          .catch(() => socket.destroy())
        void new Response(child.stderr).text()
        void child.exited.then(() => socket.destroy())
      }
      const servers = proxies.get(id) ?? new Map<number, { close: () => void }>()
      proxies.set(id, servers)
      try {
        let mapping: VmPortForward
        if ([9876, 5900].includes(guestPort)) {
          if (hostPort !== undefined) throw new Error("Private control channel")
          const socket = await privateSocket()
          const server = createServer(relay)
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject)
            server.listen(socket.path, resolve)
          })
          servers.set(guestPort, {
            close: () => {
              server.close()
              void socket.remove().catch(() => {})
            },
          })
          mapping = { guestPort, hostPort: 0, hostIp: "127.0.0.1", protocol: "tcp", url: `unix:${socket.path}` }
        } else {
          const proxy = await capabilityListener(relay, hostPort)
          servers.set(guestPort, proxy)
          mapping = { guestPort, hostPort: proxy.hostPort, hostIp: "127.0.0.1", protocol: "tcp", url: proxy.url }
        }
        ports.set(guestPort, mapping)
        return { success: true, ...mapping }
      } catch {
        return { success: false, errorCode: "COMMAND_FAILED", error: "Could not bind private forwarding channel" }
      }
    },
  }
}
