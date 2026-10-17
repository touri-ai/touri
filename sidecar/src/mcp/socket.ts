import { chmodSync, unlinkSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import { dirname } from "node:path"
import type { Kernel, ToolRegistration } from "@touri/contracts"
import { atomicWriteFile, ensurePrivateDirectory, removePrivateFile } from "../kernel/files"
import { mcpEndpoint, mcpEndpointFile, resolveMcpEndpoint } from "../platform/transport"
import { MCP_LIMITS, serveMcpConnection } from "./connection"

const unlinkIfPresent = (path: string): void => {
  try {
    unlinkSync(path)
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
  }
}

export const createMcpSocket = ({
  kernel,
  registrations,
  transport = process.platform === "win32" ? "tcp" : "local",
}: {
  kernel: Kernel
  registrations: Map<string, ToolRegistration>
  transport?: "tcp" | "local"
}) => {
  let socketPath = transport === "local" ? resolveMcpEndpoint(kernel.paths) : ""
  const tokenDir = `${kernel.paths.runDir}/mcp-tokens`
  const connections = new Set<Socket>()
  let server: Server | null = null

  const listen = async (): Promise<void> => {
    ensurePrivateDirectory({ root: kernel.paths.appData, path: tokenDir })
    if (transport === "local") {
      ensurePrivateDirectory({ root: dirname(socketPath) })
      unlinkIfPresent(socketPath)
    }
    const candidate = createServer((socket) => {
      if (connections.size >= MCP_LIMITS.connections) {
        socket.destroy()
        return
      }
      connections.add(socket)
      socket.once("close", () => connections.delete(socket))
      serveMcpConnection({ socket, kernel, tokenDir, registrations })
    })
    server = candidate
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        candidate.off("listening", onListening)
        reject(error)
      }
      const onListening = (): void => {
        candidate.off("error", onError)
        try {
          if (transport === "tcp") {
            const address = candidate.address()
            if (!address || typeof address === "string") throw new Error("MCP loopback bind failed")
            socketPath = `tcp://127.0.0.1:${address.port}`
            atomicWriteFile({
              root: kernel.paths.appData,
              path: mcpEndpointFile(kernel.paths.runDir),
              content: JSON.stringify(socketPath),
            })
          } else chmodSync(socketPath, 0o600)
          resolve()
        } catch (error) {
          candidate.close()
          reject(error)
        }
      }
      candidate.once("error", onError)
      candidate.once("listening", onListening)
      if (transport === "tcp") candidate.listen(0, "127.0.0.1")
      else candidate.listen(socketPath)
      candidate.unref()
    })
  }

  const close = async (): Promise<void> => {
    const active = server
    server = null
    if (active) {
      for (const connection of connections) connection.destroy()
      await new Promise<void>((resolve) => {
        try {
          active.close(() => resolve())
        } catch {
          resolve()
        }
      })
    }
    if (transport === "local") unlinkIfPresent(socketPath)
    else {
      try {
        if (mcpEndpoint(kernel.paths.runDir, "win32") === socketPath)
          removePrivateFile({ root: kernel.paths.appData, path: mcpEndpointFile(kernel.paths.runDir) })
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
      }
    }
  }

  return {
    listen,
    close,
    get socketPath() {
      return socketPath
    },
  }
}
