import { expect, test } from "bun:test"
import { createAppleContainerProvider } from "../../src/vm/apple-container"
import { defaultEgressPolicy, installEgressPolicy, providerHosts } from "../../src/vm/egress-policy"
import { BOT_DNS, BOT_IMAGE } from "../../src/vm/image"
import { appleContainerAvailable } from "./integration-available"

test.skipIf(!appleContainerAvailable)(
  "B11 real direct TCP to a listening host service is denied before workload readiness",
  async () => {
    const image = process.env.TOURI_VM_SECURITY_BASELINE_IMAGE ?? BOT_IMAGE
    const id = `touri-egress-probe-${process.pid}-${Date.now()}`
    const provider = createAppleContainerProvider()
    let requests = 0
    const listener = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      fetch: () => {
        requests++
        return new Response("security fixture")
      },
    })
    try {
      const current = image === BOT_IMAGE
      const created = await provider.create({
        name: id,
        image,
        cpus: 1,
        memoryMb: 512,
        ...(current ? { entrypoint: "/usr/local/lib/touri/init.sh" } : {}),
      })
      expect(created.success).toBe(true)
      expect((await provider.start({ id })).success).toBe(true)
      if (current) {
        for (let attempt = 0; attempt < 50; attempt++) {
          const ready = await provider.exec({ id, command: "test", args: ["-f", "/tmp/touri-ready"] })
          if (ready.success) break
          await Bun.sleep(100)
        }
        await installEgressPolicy(provider, id, defaultEgressPolicy())
      }
      const route = await provider.exec({ id, command: "ip", args: ["-j", "route", "show", "default"] })
      if (!route.success) throw new Error("route unavailable")
      const gateway = (JSON.parse(route.stdout) as Array<{ gateway: string }>)[0]?.gateway
      if (!gateway) throw new Error("gateway unavailable")
      const probe = await provider.exec({
        id,
        user: "1000",
        command: "curl",
        args: ["-fsS", "--max-time", "3", `http://${gateway}:${listener.port}/`],
      })
      expect(probe.success).toBe(false)
      expect(requests).toBe(0)
    } finally {
      await provider.destroy({ id })
      listener.stop(true)
    }
  },
  90000,
)

test.skipIf(!appleContainerAvailable)(
  "#4 real public allow-list: only listed and provider hosts are reachable, and turning it off restores access",
  async () => {
    const id = `touri-allowlist-probe-${process.pid}-${Date.now()}`
    const provider = createAppleContainerProvider()
    const reach = async (url: string) =>
      (
        await provider.exec({
          id,
          user: "1000",
          command: "curl",
          args: ["-sS", "-o", "/dev/null", "--max-time", "8", url],
        })
      ).success
    try {
      expect(
        (
          await provider.create({
            name: id,
            image: BOT_IMAGE,
            cpus: 1,
            memoryMb: 512,
            dns: [...BOT_DNS],
            entrypoint: "/usr/local/lib/touri/init.sh",
          })
        ).success,
      ).toBe(true)
      expect((await provider.start({ id })).success).toBe(true)
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await provider.exec({ id, command: "test", args: ["-f", "/tmp/touri-ready"] })).success) break
        await Bun.sleep(100)
      }
      const restricted = { ...defaultEgressPolicy(), restrictPublic: true, publicHosts: ["example.com"] }
      await installEgressPolicy(provider, id, restricted, undefined, providerHosts({ provider: "codex" }))
      expect(await reach("https://example.com/")).toBe(true)
      expect(await reach("https://www.example.com/")).toBe(true)
      expect(await reach("https://api.openai.com/")).toBe(true)
      expect(await reach("https://github.com/")).toBe(false)
      expect(await reach("https://1.1.1.1/")).toBe(false)
      const lookup = await provider.exec({ id, user: "1000", command: "getent", args: ["hosts", "github.com"] })
      expect(lookup.success).toBe(false)
      // Re-applying the same list keeps resolved addresses, so a running turn keeps its connection.
      await installEgressPolicy(provider, id, restricted, undefined, providerHosts({ provider: "codex" }))
      expect(await reach("https://example.com/")).toBe(true)
      await installEgressPolicy(provider, id, defaultEgressPolicy())
      expect(await reach("https://github.com/")).toBe(true)
    } finally {
      await provider.destroy({ id })
    }
  },
  120_000,
)
