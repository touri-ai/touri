import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import type { ApprovalPart, Message, MessagePart, Run, ToolCallPart } from "@touri/contracts"
import { afterEach, expect, it } from "vitest"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { TurnActivity } from "../src/components/TurnActivity"
import { assistantSegments } from "../src/components/turnActivityModel"
import { setDocumentLanguage } from "../src/documentLanguage"

afterEach(() => {
  cleanup()
  setDocumentLanguage("pt-BR", document.documentElement)
})
const tool = (index: number, name = "Read"): ToolCallPart => ({
  type: "tool_call",
  callId: `call-${index}`,
  tool: name,
  summary: "Revisar notas",
  inputJson: name === "exec_command" ? '{"command":"pwd"}' : JSON.stringify({ path: `/workspace/notas-${index}.md` }),
  outputJson: "Concluído.",
  ok: true,
})
const message = (parts: MessagePart[], overrides: Partial<Message> = {}): Message => ({
  id: "reply",
  threadId: "thread",
  parentId: null,
  role: "assistant",
  kind: "text",
  status: "complete",
  runId: null,
  text: "",
  parts,
  sender: null,
  source: "local",
  createdAt: 10_000,
  updatedAt: 190_000,
  ...overrides,
})
const props = { onSwitchBranch: () => undefined, onRetry: async () => undefined }

it("replaces 40 reasoning/tool groups with one disclosure before the visible final answer", async () => {
  const parts: MessagePart[] = Array.from({ length: 40 }, (_, index) => [
    { type: "reasoning", text: `Etapa ${index + 1}` } as const,
    tool(index, ["Read", "exec_command", "web_search", "Edit"][index % 4]),
  ]).flat()
  parts.push({ type: "text", text: "## Resultado final\n\nAs notas estão prontas." })
  const view = render(<VirtualMessageList {...props} messages={[message(parts)]} />)
  const toggle = screen.getByRole("button", { name: "Trabalhou por 3 min · 40 ações" })
  const answer = await screen.findByRole("heading", { name: "Resultado final" })
  expect(answer).toBeVisible()
  expect(toggle.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(view.container.querySelectorAll(".turn-activity")).toHaveLength(1)
  expect(view.container.querySelector(".tool-group")).toBeNull()
  expect(screen.queryByText("Etapa 40")).toBeNull()
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute("aria-expanded", "true")
  expect(view.container.querySelectorAll(".turn-activity .tool-call-card")).toHaveLength(40)
  for (const name of ["Arquivos lidos", "Comandos", "Buscas", "Edições"])
    expect(screen.getByRole("heading", { name: `${name} · 10` })).toBeVisible()
  expect(await screen.findByText("Etapa 40", { exact: false })).toBeVisible()
  fireEvent.click(toggle)
  expect(await screen.findByText("As notas estão prontas.")).toBeVisible()
})

it("preserves interleaved prose, final text and attachment order without duplicating the text cache", async () => {
  const value = message(
    [
      { type: "text", text: "Vou conferir as notas." },
      tool(1),
      { type: "reasoning", text: "Conferindo detalhes internos." },
      { type: "text", text: "Encontrei duas notas." },
      tool(2),
      { type: "file", attachmentId: "notes", name: "notas.txt", mime: "text/plain" },
      { type: "text", text: "**Resposta final:** notas revisadas." },
    ],
    { text: "Vou conferir as notas.Encontrei duas notas.Resposta final: notas revisadas." },
  )
  const view = render(<VirtualMessageList {...props} messages={[value]} />)
  await screen.findByText("Resposta final:", { selector: "strong" })
  const article = view.container.querySelector(".message-assistant")
  expect(article?.textContent).toMatch(
    /Vou conferir as notas.*2 ações.*Encontrei duas notas.*notas.txt.*Resposta final:/s,
  )
  expect(screen.getByRole("button", { name: "Baixar notas.txt" })).toBeVisible()
  expect(screen.getAllByText("Vou conferir as notas.")).toHaveLength(1)
  expect(screen.queryByText("Conferindo detalhes internos.")).toBeNull()
  expect(view.container.querySelectorAll(".turn-activity")).toHaveLength(1)
})

it("shows live browser narration as quiet transcript text", async () => {
  render(
    <VirtualMessageList
      {...props}
      messages={[
        message(
          [
            { type: "text", text: "Estou na página inicial. Agora vou escolher a data." },
            {
              ...tool(1, "mcp__touri__browser_click"),
              ok: null,
              inputJson: '{"target":{"kind":"role","role":"button","name":"Abrir calendário"}}',
            },
          ],
          { status: "streaming", sender: { id: "bot-mark", name: "Lia" } },
        ),
      ]}
    />,
  )

  const narration = await screen.findByText("Estou na página inicial. Agora vou escolher a data.")
  expect(narration.closest(".browser-narration")).not.toBeNull()
  expect(await screen.findByRole("article", { name: "Navegador do Lia" })).toBeVisible()
})

it.each(["pending", "approved", "denied", "expired"] as const)(
  "keeps a %s approval outside the activity, matched to its tool only once",
  async (decision) => {
    const call = tool(1)
    const approval: ApprovalPart = {
      type: "approval",
      approvalId: "permission",
      request: "permission",
      detail: `Read: ${call.inputJson}`,
      scope: { source: "codex", tool: "Read" },
      decision,
    }
    const view = render(
      <VirtualMessageList
        {...props}
        messages={[message([tool(0), call, approval, { type: "text", text: "Resposta após a solicitação." }])]}
      />,
    )
    const card = screen.getByRole("article", { name: "Aprovação de ferramenta" })
    expect(card).toBeVisible()
    expect(card.closest(".turn-activity")).toBeNull()
    expect(view.container.querySelectorAll('[data-call-id="call-1"]')).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: /2 ações/ }))
    expect(view.container.querySelectorAll('[data-call-id="call-1"]')).toHaveLength(1)
    expect(await screen.findByText("Resposta após a solicitação.")).toBeVisible()
  },
)

it("keeps a legacy cached final answer after activity when there are no text parts", async () => {
  const view = render(
    <VirtualMessageList
      {...props}
      messages={[
        message([{ type: "reasoning", text: "Contexto" }, tool(0)], { text: "**Concluído:** relatório disponível." }),
      ]}
    />,
  )
  const answer = await screen.findByText("Concluído:", { selector: "strong" })
  expect(answer).toBeVisible()
  const activity = view.container.querySelector(".turn-activity")
  expect(activity?.compareDocumentPosition(answer) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
})

it("describes live activity in one expandable row and collapses details when the turn finishes", async () => {
  const value = message(
    [
      { type: "reasoning", text: "Conferindo o arquivo." },
      { ...tool(1), ok: null },
    ],
    { status: "streaming" },
  )
  const view = render(<TurnActivity message={value} state="working-tool" />)
  const toggle = screen.getByRole("button", { name: /Lendo notas-1.md/ })
  expect(view.container.querySelectorAll(".activity-mark")).toHaveLength(1)
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute("aria-expanded", "true")
  expect(await screen.findByText("Conferindo o arquivo.")).toBeVisible()
  view.rerender(<TurnActivity message={{ ...value, status: "canceled" }} state="done" />)
  expect(screen.getByRole("button", { name: /1 ação/ })).toHaveAttribute("aria-expanded", "false")
  expect(view.container.querySelector(".activity-mark")).toBeNull()
})

it("uses provider-to-finish duration and translates the summary and action groups", () => {
  const value = message([tool(0), tool(0)], { createdAt: 1, updatedAt: 600_000 })
  const run = { startedAt: 1, providerStartedAt: 420_000, finishedAt: 600_000 } as Run
  render(<TurnActivity message={value} run={run} state="done" locale="en" />)
  fireEvent.click(screen.getByRole("button", { name: "Worked for 3 min · 1 action" }))
  expect(screen.getByRole("heading", { name: "Files read · 1" })).toBeVisible()
  expect(within(screen.getByRole("region", { name: "Files read" })).getAllByRole("article")).toHaveLength(1)
})

it("keeps one activity toggle when a running turn needs attention outside a tool approval", () => {
  const view = render(
    <TurnActivity
      message={message([{ type: "reasoning", text: "Aguardando a pessoa." }], { status: "streaming" })}
      state="waiting-approval"
    />,
  )
  expect(view.container.querySelectorAll(".turn-activity-toggle")).toHaveLength(1)
  const toggle = screen.getByRole("button", { name: "Preciso da sua autorização." })
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute("aria-expanded", "true")
  expect(screen.getByText("Aguardando a pessoa.")).toBeVisible()
})

const browserCall = (index: number, overrides: Partial<ToolCallPart> = {}): ToolCallPart => ({
  ...tool(index, "mcp__touri__browser_click"),
  inputJson: '{"target":{"kind":"role","role":"button","name":"Buscar"}}',
  ...overrides,
})
const browserParts: MessagePart[] = [
  { type: "text", text: "Vou abrir a busca." },
  browserCall(1),
  browserCall(2),
  { type: "text", text: "Agora vou escolher a data." },
  browserCall(3, { ok: null }),
]

it("keeps live steps and narration in order with the single card last", async () => {
  const view = render(
    <VirtualMessageList
      {...props}
      messages={[message(browserParts, { status: "streaming", sender: { id: "bot-mark", name: "Lia" } })]}
    />,
  )

  const first = await screen.findByText("Vou abrir a busca.")
  const second = screen.getByText("Agora vou escolher a data.")
  const steps = Array.from(view.container.querySelectorAll(".browser-steps"))
  const card = view.container.querySelector(".browser-activity-card")
  expect(steps.map((step) => step.textContent)).toEqual(["✓Usou o navegador", "✓Usou o navegador"])
  expect(steps[0]).toHaveAttribute("data-actions", "2")
  expect(view.container.querySelectorAll(".browser-activity-card")).toHaveLength(1)
  const order = [first, steps[0], second, steps[1], card] as Element[]
  for (const [index, element] of order.slice(1).entries())
    expect(order[index]?.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.getByText("em andamento")).toBeVisible()
  expect(screen.queryByText("Avançado")).toBeNull()
  expect(screen.queryByText("Advanced computer view")).toBeNull()
})

it("folds narration and step rows into the finished card and shows only the final answer", async () => {
  const view = render(
    <VirtualMessageList
      {...props}
      messages={[
        message([...browserParts.slice(0, 4), browserCall(3), { type: "text", text: "Voo por R$ 900" }], {
          sender: { id: "bot-mark", name: "Lia" },
        }),
      ]}
    />,
  )

  expect(await screen.findByText("Voo por R$ 900")).toBeVisible()
  expect(screen.getByText("concluído")).toBeVisible()
  expect(screen.queryByText("Vou abrir a busca.")).toBeNull()
  expect(screen.queryByText("Agora vou escolher a data.")).toBeNull()
  expect(view.container.querySelectorAll(".browser-steps")).toHaveLength(0)
  fireEvent.click(screen.getByRole("button", { name: /Usou o navegador · 3 ações/ }))
  expect(screen.getByText("Vou abrir a busca.")).toBeVisible()
  expect(screen.getByText("Agora vou escolher a data.")).toBeVisible()
  expect(view.container.querySelectorAll(".browser-activity-history .browser-steps")).toHaveLength(2)
})

it("splits browser steps between narrations in the segment model", () => {
  const segments = assistantSegments(message(browserParts, { status: "streaming" }))

  expect(segments.map((segment) => segment.type)).toEqual([
    "text",
    "activity",
    "browser-steps",
    "text",
    "browser-steps",
  ])
  expect(segments.filter((segment) => segment.type === "browser-steps").map((segment) => segment.count)).toEqual([2, 1])
})

it.each(["streaming", "complete"] as const)("keeps a %s browser card in the document language", async (status) => {
  setDocumentLanguage("en", document.documentElement)
  const reply = message([tool(1, "mcp__touri__browser_snapshot")], {
    status,
    sender: { id: "bot-lia", name: "Lia" },
  })

  render(<VirtualMessageList {...props} messages={[reply]} />)

  const card = await screen.findByRole("article", { name: "Browser for Lia" })
  expect(card).toBeVisible()
  if (status === "streaming") {
    expect(within(card).getByRole("button", { name: "Take over" })).toBeVisible()
    return
  }
  expect(within(card).getByRole("button", { name: /Used the browser/ })).toBeVisible()
})
