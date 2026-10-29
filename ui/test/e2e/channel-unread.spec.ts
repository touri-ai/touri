import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { expect, type Page, test } from "@playwright/test"
import type { ApiRoutes, Bot, BotGroup, Message, Run, Thread } from "@touri/contracts"

const cleanups = new Set<() => Promise<void>>()
test.afterEach(async () => {
  await Promise.all(Array.from(cleanups, (cleanup) => cleanup()))
  cleanups.clear()
})

type Fixture = { port: number; bots: Bot[]; group: BotGroup; thread: Thread }
type State = { messages: Message[]; runs: Run[] }

/** A real sidecar runs the channel: its bot answers "@thiago preciso de você" to the owner's request. */
const startChannel = async (page: Page) => {
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
  const call = async <Response>(path: string, method = "GET", body?: unknown): Promise<Response> => {
    const response = await fetch(`http://127.0.0.1:${fixture.port}/api/v1${path}`, {
      method,
      headers: {
        Authorization: "Bearer dev-ui-token",
        Origin: "tauri://localhost",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    })
    expect(response.ok).toBe(true)
    return response.json() as Promise<Response>
  }
  const getReads = () => call<ApiRoutes["GET /channel-reads"]["res"]>("/channel-reads")
  await page.exposeFunction("channelFixture", () => fixture)
  await page.exposeFunction("channelReadsGet", getReads)
  await page.exposeFunction("channelReadPost", () =>
    call<ApiRoutes["POST /threads/:id/read"]["res"]>(`/threads/${fixture.thread.id}/read`, "POST", {}),
  )
  await page.exposeFunction("channelSend", async (input: ApiRoutes["POST /threads/:id/messages"]["req"]) => {
    const response = await call<ApiRoutes["POST /threads/:id/messages"]["res"]>(
      `/threads/${fixture.thread.id}/messages`,
      "POST",
      input,
    )
    const getState = () => call<State>("/channel-mentions-state")
    await expect.poll(async () => (await getState()).runs.every((run) => run.status === "succeeded")).toBe(true)
    return { response, ...(await getState()) }
  })

  return { fixture, getReads }
}

// Count the short channel tone (its first note) apart from every other notification sound.
const recordChannelTone = (page: Page) =>
  page.addInitScript(() => {
    const original = AudioContext.prototype.createOscillator
    AudioContext.prototype.createOscillator = function () {
      const oscillator = original.call(this)
      oscillator.addEventListener("ended", () => {
        if (Math.abs(oscillator.frequency.value - 783.99) > 0.5) return
        const root = document.documentElement
        root.dataset.channelTones = String(Number(root.dataset.channelTones ?? 0) + 1)
      })
      return oscillator
    }
  })

for (const colorScheme of ["dark", "light"] as const)
  test(`a bot finishing in a closed channel marks it unread with a mention until it is read (${colorScheme})`, async ({
    page,
  }, info) => {
    test.setTimeout(120_000)
    await page.emulateMedia({ colorScheme })
    await page.addInitScript((theme) => localStorage.setItem("touri.appearance.v1", theme), colorScheme)
    const { getReads } = await startChannel(page)
    await recordChannelTone(page)
    const screenshot = async (name: string) => {
      const bytes = await page.screenshot({ animations: "disabled" })
      await writeFile(info.outputPath(name), bytes)
      if (!process.env.TOURI_SCREENSHOT_DIR) return

      await mkdir(process.env.TOURI_SCREENSHOT_DIR, { recursive: true })
      await writeFile(join(process.env.TOURI_SCREENSHOT_DIR, name), bytes)
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto("/test/e2e/channel-mentions-harness.html")
    const channels = page.getByRole("region", { name: "Canais" })
    const row = channels.getByRole("button", { name: /^produto/ })
    await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme)
    await expect(row).toHaveAccessibleName("produto")
    // Unlock audio with a gesture outside the channel, as a person using the app would.
    await page.getByRole("tab", { name: /^Work/ }).click()
    // The person moves to another app while the bot works.
    await page.evaluate(() => {
      document.hasFocus = () => false
      window.dispatchEvent(new Event("blur"))
    })

    await page.evaluate(() =>
      window.channelPost({ text: "@codador revisar mapa", parentId: null, clientNonce: "unread-demo" }),
    )

    // The owner asked for the task and the reply names them: one mention, shown in red, name in bold.
    await expect(row).toHaveAccessibleName("produto, 1 menção, 1 item precisa de você, 1 mensagem não lida")
    await expect(row.getByRole("img", { name: "1 menção" })).toHaveAttribute("data-tone", "mention")
    await expect(row.locator("xpath=ancestor::div[contains(@class,'sidebar-row')][1]")).toHaveClass(/has-unread/)
    await expect(page.locator("html")).toHaveAttribute("data-channel-tones", "1")
    expect((await getReads()).channels).toMatchObject([{ unread: 1, mentions: 1 }])
    await screenshot(`channel-unread-${colorScheme}-1440.png`)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole("button", { name: "Abrir menu" }).click()
    await expect(page.getByRole("region", { name: "Canais" }).getByRole("img", { name: "1 menção" })).toBeVisible()
    await screenshot(`channel-unread-${colorScheme}-390.png`)
    // Back in the app, opening the channel reads it.
    await page.evaluate(() => {
      document.hasFocus = () => true
      window.dispatchEvent(new Event("focus"))
    })

    await page
      .getByRole("region", { name: "Canais" })
      .getByRole("button", { name: /^produto/ })
      .click()

    await expect(page.getByTestId("virtual-message-list").getByText("@thiago preciso de você")).toBeVisible()
    await expect.poll(async () => (await getReads()).channels).toMatchObject([{ unread: 0, mentions: 0 }])
    // The read position lives in the sidecar, so a fresh page keeps the channel read.
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.reload()
    await page.getByRole("tab", { name: /^Work/ }).click()
    // With another conversation open, the channel row would show anything still unread.
    await page.getByRole("button", { name: /^codador/ }).click()
    await expect(page.getByRole("textbox", { name: "Mensagem para codador" })).toBeVisible()
    await expect(
      page.getByRole("region", { name: "Canais" }).getByRole("button", { name: /^produto/ }),
    ).toHaveAccessibleName("produto")
    await screenshot(`channel-read-${colorScheme}-1440.png`)
  })
