import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { expect, test } from "@playwright/test"
import type { ApiRoutes, Bot, BotGroup, Message, NotificationRecord, Run, Thread } from "@touri/contracts"

const cleanups = new Set<() => Promise<void>>()
test.afterEach(async () => {
  await Promise.all(Array.from(cleanups, (cleanup) => cleanup()))
  cleanups.clear()
})

type Fixture = { port: number; bots: Bot[]; group: BotGroup; thread: Thread }
type State = { messages: Message[]; runs: Run[]; notifications: NotificationRecord[] }

test("a real channel bot ping reaches the owner's bell and attention sound", async ({ page }, info) => {
  test.setTimeout(90_000)
  const child = spawn("bun", [resolve(import.meta.dirname, "../../../sidecar/test/fakes/channel-mentions-server.ts")], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, NODE_ENV: "test", TOURI_UI_TOKEN: "dev-ui-token", TOURI_NOTIFY_FIXTURE: "1" },
  })
  const ready = Promise.withResolvers<Fixture>()
  const lines = createInterface({ input: child.stdout })
  const timeout = setTimeout(() => ready.reject(new Error("Channel fixture startup timed out")), 60_000)
  lines.on("line", (line) => {
    if (line.startsWith("CHANNEL_FIXTURE ")) ready.resolve(JSON.parse(line.slice("CHANNEL_FIXTURE ".length)))
  })
  cleanups.add(async () => {
    clearTimeout(timeout)
    lines.close()
    if (child.exitCode !== null) return

    const exited = once(child, "exit")
    child.kill("SIGTERM")
    await exited
  })
  child.once("error", ready.reject)
  child.once("exit", (code) => ready.reject(new Error(`Channel fixture exited: ${code}`)))
  const fixture = await ready.promise
  clearTimeout(timeout)
  const headers = {
    Authorization: "Bearer dev-ui-token",
    Origin: "tauri://localhost",
    "Content-Type": "application/json",
  }
  const getState = async (): Promise<State> => {
    const response = await fetch(`http://127.0.0.1:${fixture.port}/api/v1/channel-mentions-state`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    return response.json() as Promise<State>
  }
  await page.exposeFunction("channelFixture", () => fixture)
  await page.exposeFunction("channelSend", async (input: ApiRoutes["POST /threads/:id/messages"]["req"]) => {
    const response = await fetch(`http://127.0.0.1:${fixture.port}/api/v1/threads/${fixture.thread.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10_000),
    })
    expect(response.ok).toBe(true)
    const posted = (await response.json()) as ApiRoutes["POST /threads/:id/messages"]["res"]
    expect(posted.run).toBeTruthy()
    await expect.poll(async () => (await getState()).runs.every((run) => run.status === "succeeded")).toBe(true)
    await expect.poll(async () => (await getState()).notifications.some((note) => note.kind === "mention")).toBe(true)
    return { response: posted, ...(await getState()) }
  })
  await page.addInitScript(() => {
    const original = AudioContext.prototype.createOscillator
    AudioContext.prototype.createOscillator = function () {
      const oscillator = original.call(this)
      oscillator.addEventListener("ended", () =>
        window.dispatchEvent(new CustomEvent("notification-sound-test", { detail: oscillator.frequency.value })),
      )
      return oscillator
    }
    window.addEventListener("notification-sound-test", () => {
      document.documentElement.dataset.notificationSoundCount = String(
        Number(document.documentElement.dataset.notificationSoundCount ?? 0) + 1,
      )
    })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/test/e2e/channel-mentions-harness.html?notifications=1")
  await expect(page.getByRole("textbox", { name: "Mensagem para codador" })).toBeVisible()
  await page.getByRole("textbox", { name: "Mensagem para codador" }).click()
  await page.evaluate(() =>
    window.channelPost({ text: "@codador revisar mapa", parentId: null, clientNonce: "notify-demo" }),
  )
  await expect(page.locator("html")).toHaveAttribute("data-notification-sound-count", "2")
  const state = await getState()
  expect(state.notifications.filter((note) => note.kind === "mention")).toMatchObject([
    { targetPersonId: "owner", body: "@thiago preciso de você" },
  ])
  await page.getByRole("button", { name: /Notificações/ }).click()
  const center = page.getByRole("region", { name: "Central de notificações" })
  await expect(center.getByText("@codador mencionou você em #produto", { exact: true })).toBeVisible()
  await expect(
    center.locator('[data-kind="mention"]').getByText("@thiago preciso de você", { exact: true }),
  ).toBeVisible()
  const screenshot = async (name: string) => {
    const bytes = await page.screenshot({ animations: "disabled" })
    await writeFile(info.outputPath(name), bytes)
    if (!process.env.TOURI_E2E_EVIDENCE_DIR) return

    await mkdir(process.env.TOURI_E2E_EVIDENCE_DIR, { recursive: true })
    await writeFile(join(process.env.TOURI_E2E_EVIDENCE_DIR, name), bytes)
  }
  await screenshot("channel-notification-1440.png")
  await center.getByRole("button", { name: "Fechar notificações" }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("button", { name: "Abrir menu" }).click()
  await page.getByRole("button", { name: /Notificações/ }).click()
  await expect(
    center.locator('[data-kind="mention"]').getByText("@thiago preciso de você", { exact: true }),
  ).toBeVisible()
  await screenshot("channel-notification-390.png")
})
