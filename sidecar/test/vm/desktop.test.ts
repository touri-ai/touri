import { afterEach, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { createConnection, createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot } from "@touri/contracts"
import type { WebSocketOptions } from "bun"
import { init as initComputer } from "../../src/computer"
import { createKernel } from "../../src/kernel"
import { bindDeviceSession, socketDeviceContext } from "../../src/kernel/device-session"
import { init as initStore } from "../../src/store"
import { createDesktopGateway } from "../../src/vm/desktop"
import { DesktopInputGate } from "../../src/vm/desktop-protocol"
import { machineActionRoutes } from "../../src/vm/machine-actions"
import { createVmRuntime } from "../../src/vm/runtime"
import { vncResponse } from "../../src/vm/vnc-auth"
import { socketTicket } from "../fakes/ws-ticket"
import { fakeVmProvider } from "./fake-provider"

const handshake = Buffer.from("RFB 003.008\n\x01\x01")
const key = (down = true) => Buffer.from([4, Number(down), 0, 0, 0, 0, 0, 97])
const pointer = Buffer.from([5, 1, 0, 20, 0, 30])
const update = Buffer.from([3, 1, 0, 0, 0, 0, 5, 160, 3, 132])
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const action of cleanup.splice(0)) await action()
})

test("read-only gate handles fragmented handshakes/records and drops all input", () => {
  const gate = new DesktopInputGate()
  expect(gate.push(handshake.subarray(0, 5), false)).toHaveLength(0)
  expect(gate.push(handshake.subarray(5), false)).toEqual(handshake)
  const clipboard = Buffer.concat([Buffer.from([6, 0, 0, 0, 0, 0, 0, 4]), Buffer.from("text")])
  const extendedKey = Buffer.from([255, 0, 0, 1, 0, 0, 0, 97, 0, 0, 0, 30])
  const records = Buffer.concat([key(), pointer, clipboard, extendedKey, update])
  expect(gate.push(records.subarray(0, 5), false)).toHaveLength(0)
  expect(gate.push(records.subarray(5), false)).toEqual(update)
  expect(gate.releases()).toHaveLength(0)
})

test("proxy sends each viewer handshake reply after its corresponding client step", () => {
  const steps: string[] = []
  const gate = new DesktopInputGate((phase) => steps.push(phase))
  expect(gate.push(handshake.subarray(0, 11), false)).toHaveLength(0)
  expect(steps).toEqual([])
  expect(gate.push(handshake.subarray(11, 12), false)).toHaveLength(0)
  expect(steps).toEqual(["version"])
  expect(gate.push(handshake.subarray(12, 13), false)).toHaveLength(0)
  expect(steps).toEqual(["version", "security"])
  expect(gate.push(Buffer.concat([Buffer.from([1]), key(), update]), false)).toEqual(
    Buffer.concat([Buffer.from([1]), update]),
  )
})

test("control gate releases pressed keys/buttons and rejects unknown or oversized packets", () => {
  const gate = new DesktopInputGate()
  gate.push(handshake, true)
  expect(gate.push(Buffer.concat([key(), pointer]), true)).toEqual(Buffer.concat([key(), pointer]))
  expect(gate.releases()).toEqual(Buffer.concat([key(false), Buffer.from([5, 0, 0, 20, 0, 30])]))
  expect(() => gate.push(Buffer.from([251]), true)).toThrow("desconhecido")
  const oversized = new DesktopInputGate()
  oversized.push(handshake, true)
  expect(() => oversized.push(Buffer.from([6, 0, 0, 0, 0x7f, 0xff, 0xff, 0xff]), true)).toThrow("limite")
})

test("read-only gate handles fragmented encodings, clipboard and fence headers", () => {
  const gate = new DesktopInputGate()
  gate.push(handshake, false)
  const encodings = Buffer.from([2, 0, 0, 1, 0, 0, 0, 0])
  for (const byte of encodings.subarray(0, 7)) expect(gate.push(Buffer.from([byte]), false)).toHaveLength(0)
  expect(gate.push(encodings.subarray(7), false)).toEqual(encodings)
  const fence = Buffer.from([248, 0, 0, 0, 0, 0, 0, 0, 1, 5])
  expect(gate.push(fence.subarray(0, 7), false)).toHaveLength(0)
  expect(gate.push(fence.subarray(7), false)).toEqual(fence)
  expect(gate.push(Buffer.from([6, 0, 0]), false)).toHaveLength(0)
  expect(gate.push(Buffer.from([0, 0, 0, 0, 1, 65]), false)).toHaveLength(0)
})

test("extended pointer records cannot bypass observation or leave extra mouse buttons held", () => {
  const packet = Buffer.from([5, 0x81, 0, 20, 0, 30, 1])
  const observer = new DesktopInputGate()
  observer.push(handshake, false)
  expect(observer.push(Buffer.concat([packet, update]), false)).toEqual(update)
  const controller = new DesktopInputGate()
  controller.push(handshake, true)
  expect(controller.push(packet.subarray(0, 6), true)).toHaveLength(0)
  expect(controller.push(packet.subarray(6), true)).toEqual(packet)
  expect(controller.releases()).toEqual(Buffer.from([5, 0x80, 0, 20, 0, 30, 0]))
})

test("protocol handshake rejects incompatible clients and bounds held key state", () => {
  expect(() => new DesktopInputGate().push(Buffer.from("RFB 003.003\n"), false)).toThrow("incompatível")
  const gate = new DesktopInputGate()
  gate.push(handshake, true)
  for (let value = 0; value < 256; value += 1) {
    const packet = key()
    packet.writeUInt32BE(value, 4)
    gate.push(packet, true)
  }
  const packet = key()
  packet.writeUInt32BE(256, 4)
  expect(() => gate.push(packet, true)).toThrow("limite")
})

const fixture = async (computerUse = false) => {
  const root = mkdtempSync(join(tmpdir(), "touri-desktop-test-"))
  const runtime = createKernel({ appData: root })
  await initStore(runtime.kernel)
  await initComputer(runtime.kernel)
  const fake = fakeVmProvider()
  let clock = Date.now()
  const vm = createVmRuntime({
    kernel: runtime.kernel,
    provider: fake.provider,
    now: () => clock,
    connectionKeys: { rotate: async () => randomBytes(32), remove: async () => {} },
    capability: { available: true, provider: "fake", reason: null },
  })
  runtime.kernel.services.provide("vm.runtime", vm.service)
  const received: Array<Buffer> = []
  const peers = new Set<Socket>()
  const tcp = createServer((socket) => {
    peers.add(socket)
    let phase: "version" | "security" | "response" | "ready" = "version"
    let pending = Buffer.alloc(0)
    const challenge = randomBytes(16)
    socket.on("data", (bytes) => {
      pending = Buffer.concat([pending, bytes])
      while (pending.length) {
        const length = phase === "version" ? 12 : phase === "security" ? 1 : phase === "response" ? 16 : pending.length
        if (pending.length < length) return
        const packet = pending.subarray(0, length)
        pending = pending.subarray(length)
        if (phase === "version") {
          if (packet.toString() !== "RFB 003.008\n") return socket.destroy()
          phase = "security"
          socket.write(Buffer.from([1, 2]))
        } else if (phase === "security") {
          if (packet[0] !== 2) return socket.destroy()
          phase = "response"
          socket.write(challenge)
        } else if (phase === "response") {
          if (!packet.equals(vncResponse("touri123", challenge))) return socket.destroy()
          phase = "ready"
          socket.write(Buffer.alloc(4))
        } else received.push(packet)
      }
    })
    socket.on("close", () => peers.delete(socket))
    socket.write("RFB 003.008\n")
  })
  await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve))
  const address = tcp.address()
  if (!address || typeof address === "string") throw new Error("Missing TCP port")
  const forwarded: Array<number> = []
  const desktopVm = {
    ...vm.service,
    forwardPort: async ({ guestPort }: { guestPort: number }) => {
      forwarded.push(guestPort)
      return { hostPort: address.port, url: `http://127.0.0.1:${address.port}` }
    },
    desktopConnection: async () => {
      forwarded.push(5900)
      return { hostPort: address.port, url: `http://127.0.0.1:${address.port}`, password: "touri123" }
    },
  }
  const desktop = createDesktopGateway(runtime.kernel, desktopVm)
  runtime.kernel.services.provide("vm.desktop", desktop.service)
  runtime.kernel.registerRoutes(desktop.routes)
  const request = (path: string, body: unknown = {}, method = "POST") =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method,
      headers: { Authorization: "Bearer dev-ui-token", "x-touri-client": "desktop-test" },
      ...(method !== "GET" ? { body: JSON.stringify(body) } : {}),
    })
  const bot = (
    (await (await request("/bots", { name: "Tela", provider: "codex", machine: "vm", computerUse })).json()) as {
      bot: Bot
    }
  ).bot
  const session = async (control = false) => {
    const response = await request(`/bots/${bot.id}/desktop`, { control })
    expect(response.status).toBe(200)
    return (await response.json()) as { sessionId: string; path: string; control: boolean }
  }
  cleanup.push(async () => {
    desktop.service.dispose()
    for (const socket of peers) socket.destroy()
    await new Promise<void>((resolve) => tcp.close(() => resolve()))
    await vm.dispose()
    runtime.emitHostNotification({ method: "app.willQuit", params: {} })
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    runtime,
    vm,
    desktop,
    desktopVm,
    bot,
    request,
    session,
    received,
    forwarded,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

test("chat preview never wakes a VM, cannot enable input and does not acquire a lease", async () => {
  const f = await fixture(true)
  let acquired = 0
  const acquire = f.desktopVm.acquire
  f.desktopVm.acquire = async (input) => {
    acquired++
    return acquire(input)
  }
  const stopped = await f.request(`/bots/${f.bot.id}/desktop`, { preview: true })
  expect(stopped.status).toBe(409)
  expect(acquired).toBe(0)
  expect(f.forwarded).toEqual([])
  const release = await f.vm.service.acquire({ botId: f.bot.id })
  const response = await f.request(`/bots/${f.bot.id}/desktop`, { preview: true, control: false })
  expect(response.status).toBe(200)
  expect(acquired).toBe(0)
  const session = (await response.json()) as { sessionId: string; control: boolean }
  expect(session.control).toBe(false)
  expect((await f.request(`/bots/${f.bot.id}/desktop`, { preview: true, control: true })).status).toBe(400)
  await f.request(`/desktop/${session.sessionId}`, {}, "DELETE")
  await release()
})

test("preview gate sends frame requests to the rate limiter and disables continuous updates", () => {
  const requests: Buffer[] = []
  const gate = new DesktopInputGate(undefined, (packet) => requests.push(packet))
  gate.push(handshake, false)
  const encodings = Buffer.alloc(12)
  encodings.set([2, 0, 0, 2])
  encodings.writeInt32BE(-313, 4)
  encodings.writeInt32BE(7, 8)
  const filtered = Buffer.from([2, 0, 0, 1, 0, 0, 0, 7])
  expect(
    gate.push(Buffer.concat([encodings, Buffer.from([150, 1, 0, 0, 0, 0, 1, 0, 1, 0]), key(), pointer, update]), false),
  ).toEqual(filtered)
  expect(requests).toEqual([update])
})

const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error("Expected desktop activity")
}

test("desktop session close after APP_BACKGROUND renews the ten-minute idle window", async () => {
  const f = await fixture()
  const session = await f.session()
  await f.vm.service.intent({ botId: f.bot.id, intent: "background" })
  f.advance(12 * 60_000)
  await f.vm.sweep()
  expect(f.vm.service.states()[0]?.status).toBe("running")
  f.desktop.service.close(session.sessionId)
  f.advance(2983)
  await f.vm.sweep()
  expect(f.vm.service.states()[0]?.status).toBe("running")
  f.advance(600_000 - 2983 - 1)
  await f.vm.sweep()
  expect(f.vm.service.states()[0]?.status).toBe("running")
  f.advance(1)
  await f.vm.sweep()
  expect(f.vm.service.states()[0]).toMatchObject({ status: "stopped", pauseReason: "inactivity" })
})

test("Parar máquina closes that bot's observation session and frees the viewer lease before stopping", async () => {
  const f = await fixture()
  f.runtime.kernel.registerRoutes({ name: "machine-test", routes: machineActionRoutes(f.runtime.kernel, f.vm.service) })
  const session = await f.session()
  let closed = false
  expect(f.desktop.service.claim(session.sessionId)).toBe(true)
  f.desktop.service.open(session.sessionId, {
    send: () => 1,
    close: () => {
      closed = true
    },
  })
  await f.vm.service.startService({ botId: f.bot.id })
  expect(closed).toBe(false)
  const response = await f.request(`/bots/${f.bot.id}/machine/stop`)
  expect(response.status).toBe(200)
  expect(closed).toBe(true)
  expect(f.desktop.service.claim(session.sessionId)).toBe(false)
  expect(f.vm.service.states()[0]).toMatchObject({ status: "stopped", connection: null })
})

test("stopping a bot aborts a pending viewer request without interrupting other bots' viewers", async () => {
  const f = await fixture()
  const other = (
    (await (await f.request("/bots", { name: "Outra tela", provider: "codex", machine: "vm" })).json()) as { bot: Bot }
  ).bot
  const otherResponse = await f.request(`/bots/${other.id}/desktop`)
  const otherSession = (await otherResponse.json()) as { sessionId: string }
  let aborted = false
  let entered = false
  f.desktopVm.acquire = ({ signal }) =>
    new Promise((_, reject) => {
      entered = true
      signal?.addEventListener(
        "abort",
        () => {
          aborted = true
          reject(new Error("cancelled"))
        },
        { once: true },
      )
    })
  const pending = f.request(`/bots/${f.bot.id}/desktop`)
  await until(() => entered)
  await f.desktop.service.closeBot(f.bot.id)
  expect((await pending).status).toBe(409)
  expect(aborted).toBe(true)
  expect(f.desktop.service.claim(otherSession.sessionId)).toBe(true)
})

const upgradeStatus = async (port: number, path: string, token: string, origin: string, since = "0") => {
  const ticket = await socketTicket(port, path, token)
  return new Promise<string>((resolve, reject) => {
    const peer = createConnection({ host: "127.0.0.1", port })
    let response = ""
    peer.on("error", reject)
    peer.on("data", (bytes) => {
      response += bytes.toString()
      if (response.includes("\r\n\r\n")) {
        resolve(response.split("\r\n")[0] ?? "")
        peer.destroy()
      }
    })
    peer.on("connect", () =>
      peer.write(
        `GET ${path}?ticket=${ticket}&since=${since} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
      ),
    )
  })
}

test("desktop upgrades require UI authentication and an allowed Origin before claiming the session", async () => {
  const f = await fixture()
  const session = await f.session()
  const port = f.runtime.handshake.port
  expect(await upgradeStatus(port, session.path, "wrong", "tauri://localhost")).toContain("401")
  expect(await upgradeStatus(port, session.path, "dev-ui-token", "https://example.org")).toContain("403")
  expect(await upgradeStatus(port, session.path, "dev-ui-token", "tauri://localhost", "invalid")).toContain("101")
  expect(await upgradeStatus(port, session.path, "dev-ui-token", "tauri://localhost")).toContain("410")
})

test("A03: paired human can control without automation; device revocation closes the viewer and lease", async () => {
  const f = await fixture(false)
  let releases = 0
  let closed = false
  let active = true
  f.desktopVm.acquire = async () => async () => {
    releases++
  }
  const signal = new AbortController().signal
  const device = { deviceId: "owner", active: () => active }
  bindDeviceSession(signal, device)
  const route = f.desktop.routes.routes.find((item) => item.path === "/bots/:id/desktop")
  if (!route) throw new Error("missing desktop route")
  const response = await route.handler({ params: { id: f.bot.id }, query: {}, body: { control: true }, signal })
  expect(response.status).toBe(200)
  if (!("json" in response)) throw new Error("missing session")
  const { sessionId } = response.json as { sessionId: string }
  expect(
    socketDeviceContext.run({ deviceId: "other", active: () => true }, () => f.desktop.service.claim(sessionId)),
  ).toBe(false)
  expect(socketDeviceContext.run(device, () => f.desktop.service.claim(sessionId))).toBe(true)
  f.desktop.service.open(sessionId, {
    send: () => 1,
    close: () => {
      closed = true
    },
  })
  active = false
  await until(() => closed && releases === 1)
  expect(releases).toBe(1)
  expect(f.desktop.service.claim(sessionId)).toBe(false)
})

test("failed desktop upgrades close the claimed session and release its lease", async () => {
  const f = await fixture()
  let releases = 0
  f.desktopVm.acquire = async () => async () => {
    releases += 1
  }
  const session = await f.session()
  const ticket = await socketTicket(f.runtime.handshake.port, session.path)
  const response = await fetch(`http://127.0.0.1:${f.runtime.handshake.port}${session.path}?ticket=${ticket}`, {
    headers: {
      Authorization: "Bearer dev-ui-token",
      Origin: "tauri://localhost",
      Upgrade: "websocket",
    },
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ errorCode: "WS_UPGRADE_FAILED" })
  expect(f.desktop.service.claim(session.sessionId)).toBe(false)
  expect(releases).toBe(1)
})

test("disabling automation during startup still permits independent human control", async () => {
  const f = await fixture(true)
  let finish: (() => void) | undefined
  let releases = 0
  f.desktopVm.acquire = async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return async () => {
      releases += 1
    }
  }
  const pending = f.request(`/bots/${f.bot.id}/desktop`, { control: true })
  await until(() => finish !== undefined)
  await f.request(`/bots/${f.bot.id}`, { computerUse: false }, "PATCH")
  finish?.()
  const response = await pending
  expect(response.status).toBe(200)
  const { sessionId } = await response.json()
  await f.request(`/desktop/${sessionId}`, {}, "DELETE")
  expect(releases).toBe(1)
})

test("text frames and failed viewer sends close the session and release its lease", async () => {
  const f = await fixture()
  let releases = 0
  f.desktopVm.acquire = async () => async () => {
    releases += 1
  }
  const textSession = await f.session()
  let closed = false
  f.desktop.service.claim(textSession.sessionId)
  f.desktop.service.open(textSession.sessionId, {
    send: () => 1,
    close: () => {
      closed = true
    },
  })
  f.desktop.service.message(textSession.sessionId, "invalid")
  expect(closed).toBe(true)
  expect(releases).toBe(1)
  const dropped = await f.session()
  f.desktop.service.claim(dropped.sessionId)
  f.desktop.service.open(dropped.sessionId, { send: () => 0, close: () => {} })
  await until(() => releases === 2)
  expect(f.desktop.service.claim(dropped.sessionId)).toBe(false)
})

test("authenticated one-use WS bridges the existing port-forward and blocks input in observation", async () => {
  const f = await fixture()
  const human = await f.request(`/bots/${f.bot.id}/desktop`, { control: true })
  expect(human.status).toBe(200)
  await f.request(`/desktop/${(await human.json()).sessionId}`, {}, "DELETE")
  const session = await f.session()
  expect(session.control).toBe(false)
  expect(f.forwarded).toEqual([5900, 5900])
  // Bun supports headers; lib.dom's constructor omits that overload.
  const NativeSocket = WebSocket as unknown as { new (url: string, options: WebSocketOptions): WebSocket }
  const ticket = await socketTicket(f.runtime.handshake.port, session.path)
  const socket = new NativeSocket(`ws://127.0.0.1:${f.runtime.handshake.port}${session.path}?ticket=${ticket}`, {
    headers: { "x-touri-client": "desktop-test" },
  })
  const frames: Array<string> = []
  socket.onmessage = (event) => {
    frames.push(Buffer.from(event.data as ArrayBuffer).toString())
  }
  socket.binaryType = "arraybuffer"
  await until(() => socket.readyState === WebSocket.OPEN && frames.length === 1)
  expect(frames[0]).toBe("RFB 003.008\n")
  f.runtime.kernel.publish({ type: "import.progress", importId: "isolation", phase: "done", done: 1, total: 1 })
  await Bun.sleep(10)
  expect(frames).toEqual(["RFB 003.008\n"])
  expect(f.desktop.service.claim(session.sessionId)).toBe(false)
  socket.send(Buffer.concat([handshake, key(), pointer, update]))
  await until(() => Buffer.concat(f.received).length >= 1 + update.length)
  expect(Buffer.concat(f.received)).toEqual(Buffer.concat([Buffer.from([1]), update]))
  expect(frames.join("")).not.toContain("touri123")
  socket.close()
  await until(() => socket.readyState === WebSocket.CLOSED)
  expect(f.desktop.service.claim(session.sessionId)).toBe(false)
})

test.each(["api", "hotkey"])("%s stop immediately closes control while observation stays open", async (source) => {
  const f = await fixture(true)
  const control = await f.session(true)
  const observe = await f.session()
  const controlled = {
    send: () => 1,
    close: () => {
      stopped = true
    },
  }
  let stopped = false
  let ready = false
  let observingClosed = false
  expect(f.desktop.service.claim(control.sessionId)).toBe(true)
  f.desktop.service.open(control.sessionId, {
    ...controlled,
    send: () => {
      ready = true
      return 1
    },
  })
  expect(f.desktop.service.claim(observe.sessionId)).toBe(true)
  f.desktop.service.open(observe.sessionId, {
    send: () => 1,
    close: () => {
      observingClosed = true
    },
  })
  await until(() => ready)
  f.desktop.service.message(control.sessionId, Buffer.concat([handshake, key(), pointer]))
  await until(() => Buffer.concat(f.received).length >= 1 + key().length + pointer.length)
  if (source === "api") expect((await f.request("/computer/kill")).status).toBe(200)
  else if (source === "hotkey")
    f.runtime.emitHostNotification({ method: "computer.killSwitch", params: { at: Date.now() } })
  else expect((await f.request(`/bots/${f.bot.id}`, { computerUse: false }, "PATCH")).status).toBe(200)
  expect(stopped).toBe(true)
  expect(observingClosed).toBe(false)
  expect(f.desktop.service.claim(control.sessionId)).toBe(false)
  await until(() => Buffer.concat(f.received).includes(key(false)))
})

test("a kill switch during boot cannot yield a new control session", async () => {
  const f = await fixture(true)
  let started = false
  let releaseCount = 0
  f.desktopVm.acquire = async ({ signal }) => {
    started = true
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))
    return async () => {
      releaseCount += 1
    }
  }
  const response = f.request(`/bots/${f.bot.id}/desktop`, { control: true })
  await until(() => started)
  f.desktop.service.revokeControl()
  expect((await response).status).toBe(409)
  expect(releaseCount).toBe(1)
})

test("deleting a session releases the VM lease and disposed gateways refuse connections", async () => {
  const f = await fixture()
  const session = await f.session()
  expect((await f.request(`/desktop/${session.sessionId}`, {}, "DELETE")).status).toBe(200)
  expect(f.desktop.service.claim(session.sessionId)).toBe(false)
  f.desktop.service.dispose()
  expect((await f.request(`/bots/${f.bot.id}/desktop`)).status).toBe(503)
})

test("Unicode paste requires an authenticated control session and closes with the same permission boundary", async () => {
  const f = await fixture(true)
  const observe = await f.session()
  expect((await f.request(`/desktop/${observe.sessionId}/text`, { text: "日本" })).status).toBe(403)
  const control = await f.session(true)
  expect((await f.request(`/desktop/${control.sessionId}/text`, { text: "日本" })).status).toBe(403)
  const sent: Buffer[] = []
  expect(f.desktop.service.claim(control.sessionId)).toBe(true)
  f.desktop.service.open(control.sessionId, {
    send: (data) => {
      sent.push(Buffer.from(data))
      return 1
    },
    close: () => {},
  })
  await until(() => sent.some((data) => data.toString() === "RFB 003.008\n"))
  const pasted: string[] = []
  f.desktopVm.exec = async ({ args = [] }) => {
    pasted.push(args.at(-1) ?? "")
    return { success: true, code: 0, stdout: "", stderr: "" }
  }
  expect((await f.request(`/desktop/${control.sessionId}/text`, { text: "Olá 日本😀" })).status).toBe(200)
  expect(pasted).toEqual(["Olá 日本😀"])
  expect((await f.request(`/desktop/${control.sessionId}/text`, { text: "x".repeat(65_537) })).status).toBe(400)
  expect((await f.request(`/desktop/${control.sessionId}/text`, { text: "a\0b" })).status).toBe(400)
  let canceled = false
  f.desktopVm.exec = async ({ signal }) =>
    new Promise((resolve) => {
      signal?.addEventListener(
        "abort",
        () => {
          canceled = true
          resolve({ success: false, errorCode: "CANCELED", error: "cancelado" })
        },
        { once: true },
      )
    })
  const pending = f.request(`/desktop/${control.sessionId}/text`, { text: "語" })
  await Bun.sleep(20)
  f.desktop.service.revokeControl()
  expect((await pending).status).toBe(409)
  expect(canceled).toBe(true)
  expect((await f.request(`/desktop/${control.sessionId}/text`, { text: "語" })).status).toBe(403)
})

test("desktop reconnect acquires only a running VM without machine preparation", async () => {
  const f = await fixture()
  const calls: Array<boolean | undefined> = []
  f.desktopVm.acquire = async ({ runningOnly }) => {
    calls.push(runningOnly)
    return async () => {}
  }
  const response = await f.request(`/bots/${f.bot.id}/desktop`, { resume: true })
  expect(response.status).toBe(200)
  expect(calls).toEqual([true])
})

test("human input is independent of automation and disconnect holds the bot until explicit handback", async () => {
  const f = await fixture(false)
  const human = await f.session(true)
  const input = f.runtime.kernel.services.use("computer.input")
  expect(input?.human(f.bot.id)).toBe(true)
  expect(f.runtime.kernel.services.use("store.api")?.getBot({ botId: f.bot.id })?.computerUse).toBe(false)
  await f.request(`/desktop/${human.sessionId}`, {}, "DELETE")
  const observe = await f.request(`/bots/${f.bot.id}/desktop`, { control: false, resume: true })
  expect(await observe.json()).toMatchObject({ control: false, humanControl: true })
  let injections = 0
  const pending = input?.run(
    { botId: f.bot.id, signal: new AbortController().signal } as import("@touri/contracts").ToolContext,
    async () => {
      injections++
      return { success: true, content: [] }
    },
  )
  await Bun.sleep(10)
  expect(injections).toBe(0)
  expect((await f.request(`/bots/${f.bot.id}/desktop/return`)).status).toBe(200)
  await pending
  expect(injections).toBe(1)
  expect(input?.human(f.bot.id)).toBe(false)
})

test("explicit return closes the human socket before resuming automation and invalidates pending takeover", async () => {
  const f = await fixture()
  const human = await f.session(true)
  let closed = false
  f.desktop.service.claim(human.sessionId)
  f.desktop.service.open(human.sessionId, {
    send: () => 1,
    close: () => {
      closed = true
    },
  })
  expect((await f.request(`/bots/${f.bot.id}/desktop/return`)).status).toBe(200)
  expect(closed).toBe(true)
  expect(f.desktop.service.claim(human.sessionId)).toBe(false)
  expect(f.runtime.kernel.services.use("computer.input")?.human(f.bot.id)).toBe(false)
})

test("return while takeover waits for an active input invalidates that takeover without restoring the hold", async () => {
  const f = await fixture()
  const gate = f.runtime.kernel.services.use("computer.input")
  if (!gate) throw new Error("Missing input owner")
  let finish = () => {}
  const active = gate.run(
    { botId: f.bot.id, signal: new AbortController().signal } as import("@touri/contracts").ToolContext,
    async () => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return { success: true, content: [] }
    },
  )
  const takeover = f.request(`/bots/${f.bot.id}/desktop`, { control: true })
  await until(() => gate.human(f.bot.id))
  expect((await f.request(`/bots/${f.bot.id}/desktop/return`)).status).toBe(200)
  finish()
  await active
  expect((await takeover).status).toBe(409)
  expect(gate.human(f.bot.id)).toBe(false)
})

test("a delayed handback cannot release a newer human takeover", async () => {
  const f = await fixture()
  let release = () => {}
  let closing = false
  const acquire = f.desktopVm.acquire
  f.desktopVm.acquire = async () => async () =>
    new Promise<void>((resolve) => {
      closing = true
      release = resolve
    })
  await f.session(true)
  f.desktopVm.acquire = acquire
  const handback = f.request(`/bots/${f.bot.id}/desktop/return`)
  await until(() => closing)
  const newer = await f.session(true)
  release()
  expect((await handback).status).toBe(409)
  expect(f.desktop.service.claim(newer.sessionId)).toBe(true)
  expect(f.runtime.kernel.services.use("computer.input")?.human(f.bot.id)).toBe(true)
})

test("remote runtime without input ownership support permits observation and refuses manual input", async () => {
  const f = await fixture()
  const store = f.runtime.kernel.services.use("store.api")
  if (!store) throw new Error("Missing store")
  f.runtime.kernel.services.provide("store.api", {
    ...store,
    getBot: (input) => {
      const found = store.getBot(input)
      return found?.id === f.bot.id ? { ...found, machine: "cloud" as const } : found
    },
  })
  f.desktopVm.acquire = async () => async () => {}
  expect((await f.request(`/bots/${f.bot.id}/desktop`, { control: true })).status).toBe(409)
  expect(f.forwarded).toEqual([])
  const observe = await f.request(`/bots/${f.bot.id}/desktop`, { control: false })
  expect(observe.status).toBe(200)
  expect(await observe.json()).toMatchObject({ control: false, humanControl: false })
})
