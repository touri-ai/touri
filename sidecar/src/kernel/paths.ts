import { createHash } from "node:crypto"
import { homedir, platform, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { AppPaths } from "@touri/contracts"

const defaultRoot = (): string =>
  platform() === "darwin" ? join(homedir(), "Library", "Application Support", "touri") : join(homedir(), ".touri")

export const resolveMcpSocketPath = (
  paths: Pick<AppPaths, "appData" | "runDir">,
  { platform = process.platform, tempDir = tmpdir() }: { platform?: NodeJS.Platform; tempDir?: string } = {},
): string => {
  // sun_path must also fit the terminating NUL, and paths are measured in UTF-8 bytes.
  const limit = platform === "darwin" ? 104 : 108
  const socketPath = join(paths.runDir, "mcp.sock")
  if (Buffer.byteLength(socketPath) < limit) return socketPath
  const hash = createHash("sha256").update(resolve(paths.appData)).digest("hex").slice(0, 16)
  const directory = `touri-${hash}`
  const temporaryPath = resolve(tempDir, directory, "mcp.sock")
  return Buffer.byteLength(temporaryPath) < limit ? temporaryPath : join("/tmp", directory, "mcp.sock")
}

export const createAppPaths = ({ appData }: { appData?: string } = {}): AppPaths => {
  const root = appData ?? process.env.TOURI_APP_DATA ?? defaultRoot()
  return {
    appData: root,
    db: join(root, "touri.db"),
    runDir: join(root, "run"),
    botsDir: join(root, "bots"),
    attachmentsDir: join(root, "attachments"),
    projectsDir: join(root, "projects"),
    browserDir: join(root, "browser"),
    sessionsDir: join(root, "sessions"),
    importsDir: join(root, "imports"),
    logsDir: join(root, "logs"),
    sidecarBinary: process.execPath,
  }
}
