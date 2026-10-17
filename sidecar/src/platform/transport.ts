import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { AppPaths } from "@touri/contracts"
import { resolveMcpSocketPath } from "../kernel/paths"
/** Internal endpoints never accept a remote TCP host. Token auth still runs above the transport. */
export const connectionOptions = (endpoint: string): { path: string } | { host: "127.0.0.1"; port: number } => {
  if (!endpoint.startsWith("tcp:")) return { path: endpoint }
  const url = new URL(endpoint)
  const port = Number(url.port)
  if (
    url.hostname !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    url.username ||
    url.password ||
    url.pathname ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid loopback bridge endpoint")
  return { host: "127.0.0.1", port }
}
export const mcpEndpointFile = (runDir: string) => join(runDir, "mcp-endpoint.json")
export const mcpEndpoint = (
  runDir: string,
  platform = process.platform,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string => {
  if (platform !== "win32") return resolveMcpSocketPath({ runDir, appData: dirname(runDir) }, { platform })
  const value: unknown = JSON.parse(read(mcpEndpointFile(runDir)))
  if (typeof value !== "string" || !value.startsWith("tcp:") || !("port" in connectionOptions(value)))
    throw new Error("Invalid MCP loopback endpoint")
  return value
}

export const resolveMcpEndpoint = (paths: Pick<AppPaths, "appData" | "runDir">): string =>
  process.platform === "win32" ? mcpEndpoint(paths.runDir) : resolveMcpSocketPath(paths)
