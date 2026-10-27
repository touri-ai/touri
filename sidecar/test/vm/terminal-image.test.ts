import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BOT_IMAGE, imageContext } from "../../src/vm/image"

const directories = new Set<string>()
afterEach(async () => {
  await Promise.all(Array.from(directories, (directory) => rm(directory, { recursive: true, force: true })))
  directories.clear()
})

test("the upgrade image ships a persistent unprivileged terminal and three desktop launchers", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-terminal-image-"))
  directories.add(root)

  const context = await imageContext(root)
  const files = Object.fromEntries(
    await Promise.all(
      [
        "Containerfile",
        "init.sh",
        "desktop-launcher.py",
        "terminal.sh",
        "tint2rc",
        "terminal.desktop",
        "files.desktop",
        "chrome.desktop",
        "browser-flags.json",
      ].map(async (name) => [name, await readFile(join(context, name), "utf8")]),
    ),
  )

  expect(BOT_IMAGE).toBe("touri-bot:10")
  expect(files.Containerfile).toContain("openbox tint2 xterm pcmanfm")
  expect(files["init.sh"]).toContain("untrusted timeout 0")
  expect(files["init.sh"]).toContain("Xvfb :99 -noreset")
  expect(files["init.sh"]).toContain("python3 /usr/local/lib/touri/desktop-launcher.py")
  expect(files["desktop-launcher.py"]).toContain("'/workspace/.home'")
  expect(files["desktop-launcher.py"]).toContain("os.setuid(1000)")
  expect(files["terminal.sh"]).toContain("/bin/bash --noprofile --norc -i")
  expect(files.tint2rc).toContain("launcher_item_app = /usr/local/lib/touri/terminal.desktop")
  expect(files.tint2rc).toContain("launcher_item_app = /usr/local/lib/touri/files.desktop")
  expect(files.tint2rc).toContain("launcher_item_app = /usr/local/lib/touri/chrome.desktop")
  expect(files["chrome.desktop"]).toContain("printf chrome | socat")
  expect(JSON.parse(files["browser-flags.json"] ?? "[]")).toContain("--user-data-dir=/var/lib/touri-browser/profile")
  expect(files["desktop-launcher.py"]).toContain("['pcmanfm', '/workspace']")
})
