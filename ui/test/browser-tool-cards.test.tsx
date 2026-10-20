import { cleanup, render, screen, waitFor } from "@testing-library/react"
import type { ToolCallPart } from "@touri/contracts"
import { afterEach, expect, test } from "vitest"
import { ToolCallCard } from "../src/components/ToolCallCard"

const tool: ToolCallPart = {
  type: "tool_call",
  tool: "mcp__touri__browser_open",
  callId: "open",
  inputJson: "{}",
  outputJson: null,
  summary: "MCP tool call",
  ok: null,
}
afterEach(cleanup)
test("localizes MCP browser tools and hides empty sections", () => {
  const view = render(<ToolCallCard part={tool} />)
  expect(screen.getByRole("article")).toHaveAccessibleName("Ferramenta · Abrir página")
  expect(view.container.textContent).not.toMatch(/MCP tool call|Sem parâmetros|Sem saída|\{\}/)
  expect(screen.queryByText("Resultado")).toBeNull()
  expect(screen.queryByText("Detalhes técnicos")).toBeNull()
})
test("shows URL, selector and typed text as meaningful arguments", () => {
  const view = render(
    <ToolCallCard
      part={{
        ...tool,
        tool: "mcp__playwright__browser_type",
        inputJson: '{"selector":"#busca","text":"São Paulo","url":"https://example.org"}',
      }}
    />,
  )
  expect(screen.getByRole("article")).toHaveAccessibleName("Ferramenta · Digitar")
  expect(view.container.textContent).toContain("#busca")
  expect(view.container.textContent).toContain("São Paulo")
  expect(view.container.textContent).toContain("https://example.org")
})
test("shows title, URL and screenshot thumbnail from MCP result", () => {
  render(
    <ToolCallCard
      part={{
        ...tool,
        ok: true,
        outputJson: JSON.stringify({
          structuredContent: { title: "Página de exemplo", url: "https://example.org" },
          content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
        }),
      }}
    />,
  )
  expect(screen.getByText("Página de exemplo")).toBeVisible()
  expect(screen.getByText("https://example.org")).toBeVisible()
  expect(screen.getByRole("button", { name: "Abrir captura 1 em tamanho original" })).toBeVisible()
})
test("keeps errors and hides an empty result envelope", () => {
  const view = render(
    <ToolCallCard part={{ ...tool, ok: false, outputJson: '{"error":"Não foi possível abrir a página"}' }} />,
  )
  expect(view.container.textContent).toContain("Não foi possível abrir a página")
  view.rerender(<ToolCallCard part={{ ...tool, ok: true, outputJson: '{"content":[],"structured":{}}' }} />)
  expect(screen.queryByText("Resultado")).toBeNull()
})

test("localized browser results retain safe literal output, ANSI colors and JSON highlighting", async () => {
  const literal = '<script>alert(1)</script><img src=x onerror="alert(1)">'
  const view = render(
    <ToolCallCard
      part={{
        ...tool,
        ok: true,
        outputJson: JSON.stringify({
          structuredContent: { title: "Página de exemplo", url: "https://example.org" },
          content: [{ type: "text", text: `\u001b[31m${literal}\u001b[0m` }],
        }),
      }}
    />,
  )
  expect(screen.getByRole("article")).toHaveAccessibleName("Ferramenta · Abrir página")
  expect(screen.getByText("Página de exemplo")).toBeVisible()
  expect(view.container.querySelector(".tool-output code")?.textContent).toBe(literal)
  expect(view.container.querySelector(".tool-output [data-ansi-color]")).not.toBeNull()
  expect(view.container.querySelector("script, img")).toBeNull()
  view.rerender(
    <ToolCallCard
      part={{ ...tool, ok: true, outputJson: JSON.stringify({ content: [{ type: "text", text: '{"ok":true}' }] }) }}
    />,
  )
  await waitFor(() =>
    expect(view.container.querySelector(".tool-output code")).toHaveAttribute("data-highlighted", "true"),
  )
  expect(view.container.querySelector(".tool-output code")?.textContent).toBe('{\n  "ok": true\n}')
})

test("browser card summaries say what the action targets and why it failed, in pt-BR", () => {
  const click: ToolCallPart = {
    ...tool,
    tool: "mcp__touri__browser_click",
    inputJson: '{"tabId":"t_1","target":{"kind":"role","role":"link","name":"Entrar","exact":true}}',
    ok: false,
    outputJson: JSON.stringify({
      content: [{ type: "text", text: "ERROR TARGET_COVERED: O alvo está coberto por dialog. Feche o aviso." }],
    }),
  }
  const view = render(<ToolCallCard part={click} />)
  expect(view.container.textContent).toContain('Clicar · link "Entrar" — falhou: O alvo está coberto por dialog.')
  view.rerender(
    <ToolCallCard
      part={{
        ...tool,
        tool: "mcp__touri__browser_navigate",
        inputJson: '{"tabId":"t_1","action":"reload"}',
        ok: true,
      }}
    />,
  )
  expect(view.container.textContent).toContain("Abrir página · Recarregar")
  view.rerender(
    <ToolCallCard
      part={{
        ...tool,
        tool: "mcp__touri__browser_wait_for",
        inputJson: '{"tabId":"t_1","condition":{"text":"Bem-vindo"}}',
      }}
    />,
  )
  expect(view.container.textContent).toContain('Aguardar página · texto "Bem-vindo"')
  view.rerender(
    <ToolCallCard
      part={{
        ...tool,
        tool: "mcp__touri__browser_request_takeover",
        inputJson: '{"tabId":"t_1","reason":"Faça login no banco"}',
      }}
    />,
  )
  expect(view.container.textContent).toContain("Pedir controle ao usuário · Faça login no banco")
})

test("sensitive browser actions ask the user to take over the tab", () => {
  const view = render(
    <ToolCallCard
      part={{
        ...tool,
        tool: "mcp__touri__browser_click",
        ok: false,
        inputJson: '{"tabId":"t_1","target":{"kind":"role","role":"button","name":"Buy now"}}',
        outputJson: JSON.stringify({
          content: [
            {
              type: "text",
              text: "ERROR DENIED: TOURI_BROWSER_TAKEOVER_REQUIRED|sensitive_action\\nAsk the user to take over this browser tab.",
            },
          ],
        }),
      }}
    />,
  )
  expect(view.container.textContent).toContain(
    "Esta ação do navegador precisa da sua confirmação. Assuma a aba para concluí-la.",
  )
  expect(view.container.textContent).not.toContain("TOURI_BROWSER_TAKEOVER_REQUIRED")
})

test("form submissions ask the user to take over the tab", () => {
  const view = render(
    <ToolCallCard
      part={{
        ...tool,
        tool: "mcp__touri__browser_click",
        ok: false,
        inputJson: '{"tabId":"t_1","target":{"kind":"role","role":"button","name":"Search trips"}}',
        outputJson: JSON.stringify({
          content: [
            {
              type: "text",
              text: "ERROR DENIED: TOURI_BROWSER_TAKEOVER_REQUIRED|form_submit\\nAsk the user to take over this browser tab.",
            },
          ],
        }),
      }}
    />,
  )
  expect(view.container.textContent).toContain(
    "Esta ação do navegador precisa da sua confirmação. Assuma a aba para concluí-la.",
  )
  expect(view.container.textContent).not.toContain("TOURI_BROWSER_TAKEOVER_REQUIRED")
})

test("low-confidence browser decisions ask a direct question in chat", () => {
  const view = render(
    <ToolCallCard
      part={{
        ...tool,
        tool: "mcp__touri__browser_click",
        ok: false,
        inputJson: '{"tabId":"t_1","target":{"kind":"role","role":"option","name":"Lisboa"}}',
        outputJson: JSON.stringify({
          content: [
            {
              type: "text",
              text: 'ERROR AMBIGUOUS_TARGET: Decision unclear\\nTOURI_BROWSER_DECISION_QUESTION|{"intent":"option Lisboa","choices":"Lisboa, Portugal; Lisboa Airport"}',
            },
          ],
        }),
      }}
    />,
  )
  expect(view.container.textContent).toContain("Não consegui escolher com segurança. Qual opção devo usar?")
  expect(view.container.textContent).toContain("Lisboa Airport")
})

test("browser decision fallback explains when the saved model has no credit", () => {
  const view = render(
    <ToolCallCard
      part={{
        ...tool,
        tool: "mcp__touri__browser_click",
        ok: false,
        inputJson: '{"tabId":"t_1","target":{"kind":"role","role":"option","name":"Lisboa"}}',
        outputJson: JSON.stringify({
          content: [
            {
              type: "text",
              text: "ERROR AMBIGUOUS_TARGET: Two targets match.\\nTOURI_BROWSER_DECISION_HINT|no_credit",
            },
          ],
        }),
      }}
    />,
  )
  expect(view.container.textContent).toContain(
    "A decisão assistida do navegador está sem crédito. O touri continuou usando o comportamento atual do navegador. Confira a página antes de continuar.",
  )
  expect(view.container.textContent).not.toContain("TOURI_BROWSER_DECISION_HINT")
  expect(view.container.textContent).not.toContain("Two targets match.")
})
