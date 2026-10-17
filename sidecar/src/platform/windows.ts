import { homedir } from "node:os"
import { win32 } from "node:path"
export const defaultDataRoot = (home = homedir(), env = process.env) =>
  win32.join(env.APPDATA || win32.join(home, "AppData", "Roaming"), "touri")
export const secretStoreLabel = "Windows Credential Manager"
export const secretStoreFix = "Open Credential Manager and check your Windows user session"
export const appOpenCommand = "touri.exe"
export const installTools = [
  ["git", "Install Git for Windows"],
  ["node", "Install Node.js 22 or newer"],
  ["pnpm", "npm install -g pnpm"],
  ["docker", "Start Docker Desktop with the WSL2 backend"],
]

export const systemSettingsCommand = "Review Windows network and proxy settings"
