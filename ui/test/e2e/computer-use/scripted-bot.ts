import type { Page } from "@playwright/test"
import type { MessagePart, ToolCallPart } from "@touri/contracts"
import { decideOption } from "./mock-jev"

export const BOT_NAME = "Léo"
export const TAB_ID = "cu-fixture-tab"
export const FINAL_SCREENSHOT_ID = "cu-final-screenshot"
export const FIXTURE_LOGIN_VALUE = "senha-ficticia-123"

export type FlowSnapshot = {
  parts: MessagePart[]
  running: boolean
  preview?: { image: string; title: string; url: string }
  finalText?: string
}

export type BotDeps = {
  site: Page
  siteUrl: string
  publish: (snapshot: FlowSnapshot) => Promise<void>
  waitForHandback: () => Promise<void>
  pace: number
  startedAt: number
  /** Awaited after each published step, so a test can inspect a stable frame before the bot moves on. */
  afterStep?: (index: number) => Promise<void>
}

type Step = {
  tool: string
  input: Record<string, unknown>
  run: (site: Page, siteUrl: string) => Promise<void>
  narration?: string
}

const click = (name: string) => (site: Page) => site.getByRole("button", { name }).click()

const getSteps = (): Step[] => [
  {
    tool: "browser_open",
    input: { url: "estadias.exemplo" },
    run: async (site, siteUrl) => void (await site.goto(siteUrl)),
  },
  {
    tool: "browser_snapshot",
    input: { tabId: TAB_ID },
    run: async (site) => void (await site.getByRole("heading", { name: "Encontre onde ficar" }).waitFor()),
    narration: "Estou na página inicial. Vou digitar Chicago e escolher a sugestão certa.",
  },
  {
    tool: "browser_type",
    input: { tabId: TAB_ID, target: { kind: "role", role: "combobox", name: "Destino" }, text: "Chicago" },
    run: async (site) => void (await site.getByRole("combobox", { name: "Destino" }).pressSequentially("Chicago")),
  },
  {
    tool: "browser_click",
    input: { tabId: TAB_ID, target: { kind: "role", role: "option", name: "Chicago, Illinois, EUA" } },
    run: async (site) => {
      const names = await site.getByRole("option").allTextContents()
      const decision = decideOption(
        "Chicago",
        names.map((name) => ({ ref: name, name })),
      )
      await site.getByRole("option", { name: decision?.choice ?? names[0] ?? "" }).click()
    },
  },
  {
    tool: "browser_click",
    input: { tabId: TAB_ID, target: { kind: "role", role: "button", name: "10 de novembro" } },
    run: click("10 de novembro"),
    narration: "Abri o calendário. Vou marcar de 10 a 14 de novembro e buscar.",
  },
  {
    tool: "browser_click",
    input: { tabId: TAB_ID, target: { kind: "role", role: "button", name: "14 de novembro" } },
    run: click("14 de novembro"),
  },
  {
    tool: "browser_click",
    input: { tabId: TAB_ID, target: { kind: "role", role: "button", name: "Buscar" } },
    run: (site) => site.getByRole("button", { name: "Buscar" }).click(),
  },
  {
    tool: "browser_wait_for",
    input: { tabId: TAB_ID, text: "4 estadias em Chicago" },
    run: async (site) => void (await site.getByRole("heading", { name: "4 estadias em Chicago" }).waitFor()),
  },
  {
    tool: "browser_snapshot",
    input: { tabId: TAB_ID },
    run: async (site) => void (await site.getByRole("article").first().waitFor()),
    narration: "Os resultados carregaram. Vou ordenar pela nota e conferir o preço total de cada um.",
  },
  {
    tool: "browser_screenshot",
    input: { tabId: TAB_ID },
    run: async () => undefined,
  },
]

export const FINAL_ANSWER = [
  "Encontrei 4 estadias em Chicago de 10 a 14 de novembro, da melhor nota para a pior:",
  "",
  "1. **Loft no West Loop** · nota 4,9 · R$ 3.560 no total",
  "2. **Hotel Lakeshore** · nota 4,8 · R$ 4.430 com taxas, cancelamento grátis",
  "3. **Casa Wicker Park** · nota 4,7 · R$ 2.990 no total",
  "4. **Studio River North** · nota 4,6 · R$ 2.480 no total",
].join("\n")

const LOGIN_NOTICE =
  "O site pediu login para mostrar o preço final. Não uso senhas sem você: assuma o navegador, entre e me devolva."

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const getPart = (
  index: number,
  step: Pick<Step, "tool" | "input">,
  startedAt: number,
  resolved: boolean,
): ToolCallPart => ({
  type: "tool_call",
  callId: `cu-action-${index + 1}`,
  tool: `mcp__touri__${step.tool}`,
  summary: step.tool,
  inputJson: JSON.stringify(step.input),
  outputJson:
    step.tool === "browser_screenshot" || !resolved ? null : JSON.stringify({ structured: { tabId: TAB_ID } }),
  ...(step.tool === "browser_screenshot" && resolved
    ? { outputAttachmentId: FINAL_SCREENSHOT_ID, outputBytes: 4096, outputPreview: "" }
    : {}),
  startedAt: startedAt + index * 2_000,
  ...(resolved ? { resolvedAt: startedAt + index * 2_000 + 900, ok: true } : {}),
})

const getPreview = async (site: Page) => ({
  image: `data:image/jpeg;base64,${(await site.screenshot({ type: "jpeg", quality: 70 })).toString("base64")}`,
  title: await site.title(),
  url: site.url().replace(/^https?:\/\/[^/]+/u, "estadias.exemplo"),
})

// Replays the whole concept flow against the real fixture site: 10 actions, a login wall, a take-over, the answer.
export const runScriptedBot = async (deps: BotDeps) => {
  const { site, siteUrl, publish, waitForHandback, pace, startedAt, afterStep } = deps
  const publishParts = async (parts: MessagePart[]) =>
    publish({ parts, running: true, preview: await getPreview(site) })
  const runStep = async (
    before: MessagePart[],
    index: number,
    step: Pick<Step, "tool" | "input">,
    act: () => Promise<void>,
  ) => {
    await publish({ parts: [...before, getPart(index, step, startedAt, false)], running: true })
    await act()
    await sleep(pace)
    const after = [...before, getPart(index, step, startedAt, true)]
    await publishParts(after)
    await afterStep?.(index)

    return after
  }

  const steps = getSteps()
  const searched = await steps.reduce(async (previous, step, index) => {
    const parts = await runStep(await previous, index, step, () => step.run(site, siteUrl))
    if (!step.narration) return parts
    const narrated: MessagePart[] = [...parts, { type: "text", text: step.narration }]
    await publishParts(narrated)

    return narrated
  }, Promise.resolve<MessagePart[]>([]))

  const reserve = {
    tool: "browser_click",
    input: { tabId: TAB_ID, target: { kind: "role", role: "button", name: "Reservar" } },
  }
  const reserved = await runStep(searched, 10, reserve, async () => {
    await site.getByRole("button", { name: "Reservar" }).first().click()
    await site.getByRole("heading", { name: "Entre para ver o preço final" }).waitFor()
  })
  await publishParts([...reserved, { type: "text", text: LOGIN_NOTICE }])
  await waitForHandback()

  const read = steps[1] as Step
  const finished = await runStep([...reserved, { type: "text", text: LOGIN_NOTICE }], 11, read, async () => {
    await site.getByText("Total R$ 4.430").waitFor()
  })
  await publish({ parts: finished, running: false, preview: await getPreview(site), finalText: FINAL_ANSWER })
}
