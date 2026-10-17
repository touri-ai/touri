import mermaid from "mermaid"
import { afterEach, expect, it, vi } from "vitest"
import { renderMermaid } from "../src/components/mermaidRenderer"

const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Resposta</text></svg>'
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg })) } }))
afterEach(() => vi.clearAllMocks())

it("drops queued obsolete diagrams before doing layout and keeps the latest render", async () => {
  let release: ((value: { svg: string }) => void) | undefined
  vi.mocked(mermaid.render).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const first = renderMermaid("flowchart LR\nA-->B", "dark")
  await vi.waitFor(() => expect(release).toBeDefined())
  const controller = new AbortController()
  const obsolete = renderMermaid("flowchart LR\nA-->C", "light", controller.signal)
  // Observe rejection before unblocking the queue.
  const rejection = expect(obsolete).rejects.toMatchObject({ name: "AbortError" })
  const latest = renderMermaid("flowchart LR\nA-->D", "light")
  controller.abort()
  release?.({ svg })
  await first
  await rejection
  await expect(latest).resolves.toContain("Resposta")
  expect(mermaid.render).toHaveBeenCalledTimes(2)
  expect(mermaid.render).toHaveBeenLastCalledWith(expect.any(String), "flowchart LR\nA-->D", expect.any(HTMLDivElement))
  expect(document.querySelectorAll('body > div[style*="-10000px"]')).toHaveLength(0)
})

it("rejects external image and CSS resources before creating layout DOM", async () => {
  for (const source of [
    'flowchart LR\nA@{ img: "https://example.test/image.png" }',
    'flowchart LR\nA["<img src="https://example.test/image.png">"]',
    "flowchart LR\nA-->B\nstyle A fill:url(https://example.test/image.svg)",
    "flowchart LR\nA-->B\nclassDef external fill:u\\72l(https://example.test/image.svg)",
    "flowchart LR; A-->B; classDef external fill:u\\72l(https://example.test/image.svg)",
    "flowchart LR; A-->B; style A fill:u\\72l(https://example.test/image.svg)",
  ])
    await expect(renderMermaid(source, "dark")).rejects.toThrow("Unsupported diagram resource")
  expect(mermaid.initialize).not.toHaveBeenCalled()
  expect(mermaid.render).not.toHaveBeenCalled()
})

it("cleans layout DOM after a failure and allows the next diagram to render", async () => {
  vi.mocked(mermaid.render).mockRejectedValueOnce(new Error("Invalid diagram"))
  await expect(renderMermaid("invalid", "dark")).rejects.toThrow("Invalid diagram")
  expect(document.querySelectorAll('body > div[style*="-10000px"]')).toHaveLength(0)
  await expect(renderMermaid("flowchart LR\nA-->B", "light")).resolves.toContain("Resposta")
  expect(document.querySelectorAll('body > div[style*="-10000px"]')).toHaveLength(0)
})

it("keeps rendering and appearance settings under app control", async () => {
  await renderMermaid("flowchart LR\nA-->B", "light")
  expect(mermaid.initialize).toHaveBeenLastCalledWith(
    expect.objectContaining({
      theme: "default",
      securityLevel: "strict",
      htmlLabels: false,
      secure: expect.arrayContaining(["securityLevel", "htmlLabels", "theme", "themeCSS", "dompurifyConfig"]),
    }),
  )
})
