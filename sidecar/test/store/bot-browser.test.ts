import { expect, mock, test } from "bun:test"
import type { Bot, VmRuntime } from "@touri/contracts"
import { normalizeErrorBody } from "../../src/kernel/errors"
import { init } from "../../src/store"
import { testKernel } from "../kernel/test-kernel"

test("unrelated VM PATCH and capability approval preserve login while allowing explicit opt-out", async () => {
  const f = testKernel()
  try {
    await init(f.kernel)
    const stop = mock(async () => {})
    f.kernel.services.provide("vm.runtime", { capability: { available: true }, stop } as unknown as VmRuntime)
    const { bot } = (
      await f.request("POST /bots", {
        name: "QA VM",
        provider: "codex",
        machine: "vm",
        vmProviderLogin: true,
      })
    ).json as { bot: Bot }
    for (const patch of [{ browserEnabled: false }, { name: "QA VM renamed" }, { machineIdleMinutes: 20 }]) {
      const response = await f.request("PATCH /bots/:id", patch, { id: bot.id })
      expect(response.status).toBe(200)
      expect(response.json).toMatchObject({ bot: { ...patch, vmProviderLogin: true, providerProfile: null } })
    }
    const approval = await f.kernel.services.use("bots.configureAccess")?.({
      botId: bot.id,
      patch: { browserEnabled: true },
    })
    expect(approval).toMatchObject({ success: true, bot: { browserEnabled: true, vmProviderLogin: true } })
    expect(stop).not.toHaveBeenCalled()
    expect((await f.request("PATCH /bots/:id", { vmProviderLogin: false }, { id: bot.id })).json).toMatchObject({
      bot: { vmProviderLogin: false },
    })
  } finally {
    f.close()
  }
})

test("store persists browser choices and rejects local Chrome on VM create, patch and machine changes", async () => {
  const f = testKernel()
  try {
    await init(f.kernel)
    const { bot } = (await f.request("POST /bots", { name: "Host", provider: "codex" })).json as { bot: Bot }
    expect(bot.browser).toBe("touri")
    expect((await f.request("PATCH /bots/:id", { browser: "local" }, { id: bot.id })).json).toMatchObject({
      bot: { browser: "local" },
    })
    expect((await f.request("PATCH /bots/:id", { name: "Keep choice" }, { id: bot.id })).json).toMatchObject({
      bot: { browser: "local" },
    })
    for (const body of [
      { machine: "vm" },
      { machine: "vm", browser: "local" },
      { machine: "cloud", browser: "local" },
    ]) {
      const result = await f.request("PATCH /bots/:id", body, { id: bot.id })
      expect(result.status).toBe(400)
      expect(normalizeErrorBody(result.json, result.status)).toMatchObject({
        errorCode: "LOCAL_BROWSER_REQUIRES_HOST",
        error: expect.stringContaining("máquina remota não pode acessar"),
      })
    }
    expect(
      (await f.request("POST /bots", { name: "VM", provider: "codex", machine: "vm", browser: "local" })).status,
    ).toBe(400)
    for (const browser of ["firefox", null, false, 1, {}])
      expect((await f.request("PATCH /bots/:id", { browser }, { id: bot.id })).status).toBe(400)
    f.kernel.services.provide("vm.runtime", {
      capability: { available: true },
      stop: async () => {},
    } as unknown as VmRuntime)
    expect(
      (await f.request("PATCH /bots/:id", { machine: "vm", browser: "machine" }, { id: bot.id })).json,
    ).toMatchObject({ bot: { machine: "vm", browser: "machine" } })
    expect((await f.request("PATCH /bots/:id", { machine: "local" }, { id: bot.id })).json).toMatchObject({
      bot: { machine: "local", browser: "touri" },
    })
  } finally {
    f.close()
  }
})
