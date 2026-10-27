import { join } from "node:path"
import { ensurePrivateDirectoryAsync, writePrivateFileAsync } from "../kernel/async-files"
import { BROWSER_FLAGS } from "./browser-launch"
import containerfile from "./image/Containerfile" with { type: "text" }
import chrome from "./image/chrome.desktop" with { type: "text" }
import computer from "./image/computer.py" with { type: "text" }
import connection from "./image/connection.cjs" with { type: "text" }
import desktop from "./image/desktop-launcher.py" with { type: "text" }
import heartbeat from "./image/display-heartbeat.py" with { type: "text" }
import files from "./image/files.desktop" with { type: "text" }
import init from "./image/init.sh" with { type: "text" }
import bridge from "./image/mcp-bridge.cjs" with { type: "text" }
import stdio from "./image/mcp-stdio.cjs" with { type: "text" }
import network from "./image/network-policy.py" with { type: "text" }
import openbox from "./image/openbox.conf" with { type: "text" }
import terminal from "./image/terminal.desktop" with { type: "text" }
import launchTerminal from "./image/terminal.sh" with { type: "text" }
import panel from "./image/tint2rc" with { type: "text" }
import password from "./image/vnc-password.cjs" with { type: "text" }
import authority from "./image/x-authority.py" with { type: "text" }

export const BOT_IMAGE = "touri-bot:10"
// The container gateway resolver (192.168.64.1) can die while the host network
// still works (e.g. under a VPN), so bot machines get explicit resolvers.
export const BOT_DNS = ["1.1.1.1", "8.8.8.8"]
export const imageContext = async (root: string): Promise<string> => {
  const directory = join(root, "vm-image-10")
  await ensurePrivateDirectoryAsync({ root, path: directory })
  for (const [name, content] of Object.entries({
    Containerfile: containerfile,
    "network-policy.py": network,
    "x-authority.py": authority,
    "computer.py": computer,
    "display-heartbeat.py": heartbeat,
    "init.sh": init,
    "mcp-bridge.cjs": bridge,
    "mcp-stdio.cjs": stdio,
    "connection.cjs": connection,
    "vnc-password.cjs": password,
    "desktop-launcher.py": desktop,
    "browser-flags.json": JSON.stringify(BROWSER_FLAGS),
    "chrome.desktop": chrome,
    "files.desktop": files,
    "openbox.conf": openbox,
    "terminal.desktop": terminal,
    "terminal.sh": launchTerminal,
    tint2rc: panel,
  }))
    await writePrivateFileAsync({ root, path: join(directory, name), content })
  return directory
}
