import type { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, UiEvent } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { flushFileIoAsync } from "../../src/kernel/async-files"
import { init as initStore } from "../../src/store"
import { createAppleContainerProvider } from "../../src/vm/apple-container"
import { createVmCommandRunner } from "../../src/vm/command"
import { BOT_IMAGE } from "../../src/vm/image"
import { createVmRuntime } from "../../src/vm/runtime"
import type { VmVolumeSpec } from "../../src/vm/types"
import { appleContainerAvailable } from "./integration-available"

const hasImage = (image: string): boolean =>
  appleContainerAvailable &&
  Bun.spawnSync([Bun.which("container") ?? "container", "image", "inspect", image]).exitCode === 0
const cases = [
  { storage: "volume", source: "touri-bot:5" },
  { storage: "volume", source: "touri-bot:6" },
  { storage: "volume", source: "touri-bot:7" },
  { storage: "rootfs", source: "node:22-alpine" },
] as const

for (const { storage, source } of cases) {
  test.skipIf(!appleContainerAvailable || !hasImage(source))(
    `real Apple Container upgrade preserves workspace and home from ${storage} (${source}); current image reuses it`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), "touri-upgrade-"))
      const runtime = createKernel({ appData: join(root, "data") })
      const commands: string[][] = []
      const run = createVmCommandRunner({ binary: Bun.which("container") ?? "container" })
      const provider = createAppleContainerProvider({
        runCommand: async (args, options) => {
          commands.push(args)
          return run(args, options)
        },
      })
      await initStore(runtime.kernel)
      const vm = createVmRuntime({
        kernel: runtime.kernel,
        provider,
        connectionKeys: { rotate: async () => randomBytes(32), remove: async () => {} },
      })
      runtime.kernel.services.provide("vm.runtime", vm.service)
      const id = `touri-upgrade-test-${process.pid}-${Date.now()}`
      const volume = `${id}-workspace`
      let botId: string | null = null
      let release: (() => Promise<void>) | null = null
      const events: UiEvent[] = []
      const unsubscribe = runtime.kernel.subscribe(({ event }) => events.push(event))
      try {
        const response = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1/bots`, {
          method: "POST",
          headers: {
            Authorization: "Bearer dev-ui-token",
            "x-touri-client": "vm-upgrade-test",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "Disposable upgrade", provider: "codex", machine: "vm" }),
        })
        expect(response.status).toBe(201)
        const bot = ((await response.json()) as { bot: Bot }).bot
        botId = bot.id
        let mounts: VmVolumeSpec[] = []
        if (storage === "volume") {
          expect((await provider.createVolume({ name: volume })).success).toBe(true)
          mounts = [{ type: "volume", source: volume, target: "/workspace" }]
        }
        expect(
          (
            await provider.create({
              name: id,
              image: source,
              cpus: 1,
              memoryMb: 512,
              volumes: mounts,
            })
          ).success,
        ).toBe(true)
        expect((await provider.start({ id })).success).toBe(true)
        expect(
          (
            await provider.exec({
              id,
              command: "node",
              args: [
                "-e",
                `const fs=require('fs');fs.mkdirSync('/workspace/.home/.config',{recursive:true});fs.writeFileSync('/workspace/user.txt','user data');fs.writeFileSync('/workspace/.home/.config/settings','home data');fs.writeFileSync('/workspace/binary',Buffer.from([0,1,255]));${storage === "rootfs" ? "fs.writeFileSync('/home/node/legacy.txt','legacy home');" : ""}`,
              ],
            })
          ).success,
        ).toBe(true)
        expect(
          (await provider.exec({ id, command: "chown", args: ["-hR", "1000:1000", "/workspace", "/home/node"] }))
            .success,
        ).toBe(true)
        expect((await provider.stop({ id })).success).toBe(true)
        const inspected = await provider.inspect({ id })
        expect(inspected.success).toBe(true)
        const db = runtime.kernel.db as Database
        db.query("INSERT INTO bot_machines(bot_id, vm_id, volume) VALUES (?, ?, ?)").run(bot.id, id, volume)
        release = await vm.service.acquire({ botId: bot.id })
        const upgraded = await provider.inspect({ id })
        expect(upgraded.success && upgraded.image).toBe(BOT_IMAGE)
        if (storage !== "rootfs" && inspected.success && upgraded.success) {
          const mount = inspected.volumes[0]
          if (!mount) throw new Error("Missing original workspace mount")
          expect(upgraded.volumes).toContainEqual(mount)
        }
        const content = await vm.service.exec({
          botId: bot.id,
          command: "node",
          args: [
            "-e",
            "const fs=require('fs');console.log(fs.readFileSync('/workspace/user.txt','utf8'),fs.readFileSync('/workspace/.home/.config/settings','utf8'),fs.readFileSync('/workspace/binary').toString('hex'))",
          ],
        })
        expect(content.success && content.stdout.trim()).toBe("user data home data 0001ff")
        await vm.service.writeFile({ botId: bot.id, path: "/workspace/user.txt", content: "user data" })
        if (storage === "rootfs") {
          const home = await vm.service.exec({ botId: bot.id, command: "cat", args: ["/workspace/.home/legacy.txt"] })
          expect(home.success && home.stdout).toBe("legacy home")
        }
        expect(
          events.some(
            (event) =>
              event.type === "machine.updated" &&
              event.machine.progress === "Atualizando a máquina para a versão nova…",
          ),
        ).toBe(true)
        await flushFileIoAsync()
        expect(readFileSync(join(runtime.kernel.paths.logsDir, "sidecar.log"), "utf8")).toContain('"stage":"upgrade"')
        await release()
        release = null
        await vm.service.stop({ botId: bot.id })
        const creates = commands.filter((args) => args[0] === "create").length
        release = await vm.service.acquire({ botId: bot.id })
        expect(commands.filter((args) => args[0] === "create")).toHaveLength(creates)
        const persisted = await vm.service.exec({ botId: bot.id, command: "cat", args: ["/workspace/user.txt"] })
        expect(persisted.success && persisted.stdout).toBe("user data")
      } finally {
        unsubscribe()
        await release?.()
        if (botId) await vm.service.destroy({ botId })
        await vm.dispose()
        await provider.destroy({ id })
        if (storage === "volume") await provider.deleteVolume({ name: volume })
        runtime.stop()
        rmSync(root, { recursive: true, force: true })
      }
    },
    180_000,
  )
}

const run = createVmCommandRunner({ binary: Bun.which("container") ?? "container", timeoutMs: 5000 })
const oldImageAvailable = appleContainerAvailable && (await run(["image", "inspect", "touri-bot:1"])).code === 0
test.skipIf(!oldImageAvailable)(
  "real old bot image warm start clears stale display 99 locks before its init",
  async () => {
    const provider = createAppleContainerProvider()
    const id = `touri-old-boot-test-${process.pid}-${Date.now()}`
    const legacyInit = `#!/bin/sh
exec node -e "require('child_process').spawn('Xvfb',[':99','-screen','0','1440x900x24','-nolisten','tcp'],{stdio:'ignore'});setInterval(()=>{},1000)"
`
    try {
      expect(
        (
          await provider.create({
            name: id,
            image: "touri-bot:1",
            entrypoint: "/usr/local/lib/touri/init.sh",
            args: [],
            cpus: 1,
            memoryMb: 1024,
          })
        ).success,
      ).toBe(true)
      expect((await provider.start({ id })).success).toBe(true)
      // Use an init without cleanup or an Xvfb exit monitor, reproducing the
      // failed-display/remaining-bridge state deterministically in this guest.
      expect(
        (
          await provider.exec({
            id,
            command: "python3",
            args: [
              "-c",
              `from pathlib import Path; Path('/usr/local/lib/touri/init.sh').write_text(${JSON.stringify(legacyInit)})`,
            ],
          })
        ).success,
      ).toBe(true)
      expect((await provider.stop({ id })).success).toBe(true)
      expect((await provider.start({ id })).success).toBe(true)
      for (let attempt = 0; attempt < 50; attempt++) {
        const result = await provider.exec({
          id,
          command: "xdotool",
          args: ["getdisplaygeometry"],
          env: { DISPLAY: ":99" },
        })
        if (result.success) break
        await Bun.sleep(100)
      }
      // Kill the display and leave its stale lock in this disposable VM.
      expect((await provider.exec({ id, command: "pkill", args: ["-9", "Xvfb"] })).success).toBe(true)
      // The init remains alive; no live display may race the test.
      expect(
        (
          await provider.exec({
            id,
            command: "touch",
            args: ["/tmp/.X99-lock", "/tmp/.X88-lock", "/tmp/.X11-unix/X88"],
          })
        ).success,
      ).toBe(true)
      expect((await provider.stop({ id })).success).toBe(true)
      expect((await provider.start({ id })).success).toBe(true)
      let ready = false
      for (let attempt = 0; attempt < 50; attempt++) {
        const result = await provider.exec({
          id,
          command: "xdotool",
          args: ["getdisplaygeometry"],
          env: { DISPLAY: ":99" },
        })
        if (result.success) {
          ready = true
          break
        }
        await Bun.sleep(100)
      }
      expect(ready).toBe(true)
      expect((await provider.exec({ id, command: "test", args: ["!", "-e", "/tmp/.X88-lock"] })).success).toBe(true)
      expect((await provider.exec({ id, command: "test", args: ["!", "-e", "/tmp/.X11-unix/X88"] })).success).toBe(true)
    } finally {
      await provider.destroy({ id })
    }
  },
  90_000,
)
