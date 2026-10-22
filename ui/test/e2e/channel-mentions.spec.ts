import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { test as base, expect } from "@playwright/test"
import type { ApiRoutes, Bot, BotGroup, Message, Run, Thread } from "@touri/contracts"

type Fixture = { port: number; bots: Bot[]; group: BotGroup; thread: Thread }
type State = { messages: Message[]; runs: Run[] }
const test = base.extend<{ channelServer: Fixture }>({
  channelServer: async (_deps, use) => {
    const child = spawn(
      "bun",
      [resolve(import.meta.dirname, "../../../sidecar/test/fakes/channel-mentions-server.ts")],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NODE_ENV: "test", TOURI_UI_TOKEN: "dev-ui-token" },
      },
    )
    const ready = Promise.withResolvers<Fixture>()
    const lines = createInterface({ input: child.stdout })
    const timeout = setTimeout(() => ready.reject(new Error("Channel fixture startup timed out")), 30_000)
    lines.on("line", (line) => {
      if (line.startsWith("CHANNEL_FIXTURE ")) ready.resolve(JSON.parse(line.slice("CHANNEL_FIXTURE ".length)))
    })
    child.once("error", ready.reject)
    child.stderr.resume()
    const fixture = await ready.promise
    clearTimeout(timeout)
    await use(fixture)
    lines.close()
    const exited = once(child, "exit")
    child.kill("SIGTERM")
    await exited
  },
})

test("channel messages stay quiet until a bot is mentioned", async ({ page, channelServer }, info) => {
  test.setTimeout(60_000)
  const headers = {
    Authorization: "Bearer dev-ui-token",
    Origin: "tauri://localhost",
    "Content-Type": "application/json",
  }
  const getState = async (): Promise<State> => {
    const response = await fetch(`http://127.0.0.1:${channelServer.port}/api/v1/channel-mentions-state`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    return response.json() as Promise<State>
  }
  await page.exposeFunction("channelFixture", () => channelServer)
  await page.exposeFunction("channelSend", async (input: ApiRoutes["POST /threads/:id/messages"]["req"]) => {
    const result = await fetch(
      `http://127.0.0.1:${channelServer.port}/api/v1/threads/${channelServer.thread.id}/messages`,
      { method: "POST", headers, body: JSON.stringify(input), signal: AbortSignal.timeout(10_000) },
    )
    expect(result.ok).toBe(true)
    const response = (await result.json()) as ApiRoutes["POST /threads/:id/messages"]["res"]
    if (response.run)
      await expect.poll(async () => (await getState()).runs.every((run) => run.status === "succeeded")).toBe(true)
    return { response, ...(await getState()) }
  })
  const screenshot = async (name: string) => {
    const bytes = await page.screenshot({ animations: "disabled" })
    await writeFile(info.outputPath(name), bytes)
    const directory = process.env.TOURI_E2E_EVIDENCE_DIR
    if (!directory) return

    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, name), bytes)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/test/e2e/channel-mentions-harness.html")
  await page
    .getByRole("region", { name: "Canais" })
    .getByRole("button", { name: /^produto/ })
    .click()
  const composer = page.getByRole("textbox", { name: "Mensagem para produto" })
  await expect(composer).toHaveAttribute("placeholder", "Mensagem em #produto · @ chama um bot")

  await composer.fill("oi")
  await composer.press("Enter")
  await expect(page.getByTestId("virtual-message-list").getByText("oi", { exact: true })).toBeVisible()
  await expect.poll(async () => (await getState()).messages.length).toBe(1)
  expect((await getState()).runs).toEqual([])
  await expect(page.locator(".browser-activity-card,.group-run-card,.activity-mark")).toHaveCount(0)
  await expect(page.getByText("Ainda aguardando a IA responder.")).toHaveCount(0)
  await screenshot("channel-plain-message.png")

  await composer.fill("@")
  await expect(page.getByRole("option", { name: "@codador" })).toBeVisible()
  await screenshot("channel-mention-autocomplete.png")
  await composer.press("Enter")
  await composer.press("o")
  await composer.press("i")
  await expect(composer).toHaveValue("@codador oi")
  await screenshot("channel-mention-chip.png")
  await composer.press("Enter")
  await expect(page.getByTestId("virtual-message-list").getByText("codador respondeu.", { exact: true })).toBeVisible()
  const state = await getState()
  expect(state.runs.every((run) => run.botId === channelServer.bots[0]?.id)).toBe(true)
  expect(
    state.messages.filter((message) => message.role === "assistant").map((message) => message.sender?.name),
  ).toEqual(["codador"])
  await screenshot("channel-mentioned-bot-reply.png")
  await page.setViewportSize({ width: 390, height: 844 })
  await screenshot("channel-mentions-phone.png")
})
