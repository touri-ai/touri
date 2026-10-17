import { existsSync } from "node:fs"
import { homedir, release } from "node:os"
import { posix } from "node:path"
import { withToolPath } from "../kernel/shell-env"

const { join } = posix

import type { MachineCapability } from "@touri/contracts"
export const defaultDataRoot = (home = homedir()) => join(home, "Library", "Application Support", "touri")
export const machineCapability = (): MachineCapability => {
  if (process.env.TOURI_HEADLESS === "1")
    return { available: false, reason: "sem virtualização neste host", provider: null }
  if (process.arch !== "arm64")
    return { available: false, reason: "Apple container requer Apple Silicon", provider: null }
  if (Number(release().split(".")[0]) < 25)
    return { available: false, reason: "Apple container requer macOS 26", provider: null }
  if (!Bun.which("container", { PATH: withToolPath().PATH }))
    return { available: false, reason: "container não está instalado", provider: null }
  return { available: true, reason: null, provider: "apple-container" }
}
export const focusChrome = { cmd: "/usr/bin/osascript", args: ["-e", 'tell application "Google Chrome" to activate'] }
export const secretStoreLabel = "Chaves do macOS"
export const secretStoreFix = "open -a 'Keychain Access'"
export const appOpenCommand = "open -a touri"
export const installTools = [
  ["git", "xcode-select --install"],
  ["brew", "open https://brew.sh"],
  ["node", "brew install node"],
  ["pnpm", "npm install -g pnpm"],
  ["mongod", "brew tap mongodb/brew && brew install mongodb-community"],
  ["redis-server", "brew install redis"],
  ["docker", "brew install --cask docker"],
]

export const systemSettingsCommand = "open /System/Applications/System\\ Settings.app"

export const containerKernelPresent = () =>
  existsSync(join(homedir(), "Library/Application Support/com.apple.container/kernels/default.kernel-arm64"))
