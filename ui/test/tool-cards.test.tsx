import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ApprovalPart, MessagePart, ToolCallPart } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { ApprovalCard } from "../src/components/ApprovalCard"
import { fenceCode } from "../src/components/codeFence"
import { MarkdownContent } from "../src/components/MarkdownContent"
import { ToolCallCard } from "../src/components/ToolCallCard"
import { ToolCallList } from "../src/components/ToolCallList"
import { approvalMatchesTool, type ToolPart } from "../src/components/toolPresentation"
import { t } from "../src/i18n"

const timestamp = new Date("2026-10-13T20:21:00Z").getTime()
const tool: ToolCallPart = {
  type: "tool_call",
  callId: "bash-1",
  tool: "Bash",
  summary: "Claude tool Bash",
  inputJson: '{"command":"printf QA_R7_APROVADO","description":"Imprimir marcador aprovado"}',
  outputJson: null,
  ok: null,
}
const approval: ApprovalPart = {
  type: "approval",
  approvalId: "approval-1",
  request: "permission",
  detail: `Bash: ${tool.inputJson}`,
  scope: { source: "claude", tool: "Bash" },
  allowStanding: true,
  decision: "pending",
}
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it.each([
  ["process_list", {}, "Listar processos", "Consultar os processos do projeto e seus estados"],
  ["process_define", { name: "web", command: "bun dev" }, "Definir processo", "Definir o processo web: bun dev"],
  ["process_start", { name: "web" }, "Iniciar processo", "Iniciar o processo web"],
  ["process_stop", { name: "web" }, "Parar processo", "Parar o processo web"],
  ["process_restart", { name: "web" }, "Reiniciar processo", "Reiniciar o processo web"],
  ["process_logs", { name: "web" }, "Ler logs", "Consultar os logs do processo web"],
  ["preview_open", { path: "/health" }, "Abrir prévia", "Abrir a prévia do projeto em /health"],
] as const)("F017: localizes %s with a task description", (name, args, title, summary) => {
  for (const toolName of [name, `mcp__touri__${name}`]) {
    const view = render(
      <ToolCallCard part={{ ...tool, tool: toolName, inputJson: JSON.stringify(args), summary: "MCP tool call" }} />,
    )
    expect(screen.getByText(title)).toBeVisible()
    expect(view.container.querySelector(".tool-summary")).toHaveTextContent(summary)
    expect(view.container.querySelector(".tool-summary")).not.toHaveTextContent("MCP tool call")
    view.unmount()
  }
})

for (const field of ["file_path", "path", "filePath"]) {
  it(`presents Read ${field} as a file chip with no JSON or field names`, () => {
    const path = "/Users/user/javascript/my-app/README.md"
    const view = render(
      <ApprovalCard
        part={{
          ...approval,
          detail: `Read: ${JSON.stringify({ [field]: path })}`,
          scope: { source: "claude", tool: "Read" },
        }}
        api={createMockApi()}
      />,
    )
    expect(screen.getByText("Ler arquivo")).toBeVisible()
    const files = screen.getByRole("list", { name: "Arquivos" })
    expect(files).toHaveTextContent(path)
    expect(files.querySelector(".tool-file-chip")).toHaveAttribute("title", path)
    expect(files.querySelector("strong")).toHaveTextContent("README.md")
    expect(view.container.querySelector(".tool-input")).toBeNull()
    expect(view.container.querySelector(".tool-summary")).toHaveTextContent("Consultar o conteúdo do arquivo")
    expect(view.container.querySelector(".tool-technical")).not.toHaveAttribute("open")
  })
}

it("retains Read ranges separately from the file chip", () => {
  render(
    <ToolCallCard part={{ ...tool, tool: "Read", inputJson: '{"file_path":"README.md","offset":20,"limit":10}' }} />,
  )
  expect(screen.getByRole("list", { name: "Arquivos" })).toHaveTextContent("README.md")
  expect(screen.getByRole("figure", { name: "Parâmetros" })).toHaveTextContent("offset: 20")
  expect(screen.getByRole("figure", { name: "Parâmetros" })).not.toHaveTextContent("file_path")
})

it("shows only the Bash command, a human description, one friendly title and opt-in technical JSON", async () => {
  const user = userEvent.setup()
  const view = render(<ApprovalCard part={approval} api={createMockApi()} createdAt={timestamp} />)
  expect(screen.getAllByText("Terminal")).toHaveLength(1)
  expect(screen.getByText("Imprimir marcador aprovado")).toBeVisible()
  expect(screen.getByRole("figure", { name: "Comando" })).toHaveTextContent(/^printf QA_R7_APROVADO$/)
  const technical = view.container.querySelector(".tool-technical")
  expect(technical).not.toHaveAttribute("open")
  await user.click(screen.getByText("Detalhes técnicos"))
  expect(technical).toHaveAttribute("open")
  expect(technical).toHaveTextContent('"command": "printf QA_R7_APROVADO"')
  expect(view.container.querySelector(".tool-kind-icon svg")).toHaveAttribute("aria-hidden", "true")
})

it("renders historical plain-text Bash envelopes as the command alone", () => {
  render(<ApprovalCard part={{ ...approval, detail: "Bash: date +%H:%M" }} api={createMockApi()} />)
  expect(screen.getByRole("figure", { name: "Comando" })).toHaveTextContent(/^date \+%H:%M$/)
})

for (const [name, friendly] of [
  ["browser_navigate", "Abrir página"],
  ["computer_click", "Computador"],
  ["mcp__docs__save", "docs · save"],
] as const) {
  it(`renders ${name} with a friendly name and readable nested key/value arguments`, () => {
    render(
      <ToolCallCard
        part={{ ...tool, tool: name, inputJson: '{"url":"https://example.test","position":{"x":12,"y":24}}' }}
      />,
    )
    expect(screen.getByText(friendly)).toBeVisible()
    const args = screen.getByRole("figure", { name: "Parâmetros" })
    expect(args).toHaveTextContent(`${name === "browser_navigate" ? "URL" : "url"}: https://example.test`)
    expect(args).toHaveTextContent("position.x: 12")
    expect(args).not.toHaveTextContent(/[{}]/)
  })
}

for (const [label, patch, finished] of [
  ["Executando", {}, false],
  ["Concluído", { ok: true, resolvedAt: timestamp }, false],
  ["Erro", { ok: false, resolvedAt: timestamp }, false],
  ["Encerrado", {}, true],
  ["Encerrado", { resolution: "interrupted" }, false],
  ["Encerrado", { resolution: "canceled" }, false],
  ["Encerrado", { resolution: "unknown" }, false],
  ["Encerrado", { resolution: "cancelled_by_user" }, false],
  ["Encerrado", { resolution: "interrupted_by_restart" }, false],
  ["Concluído", { resolution: "completed_unobserved", ok: true }, false],
  ["Erro", { resolution: "completed_unobserved", ok: false }, false],
] as const) {
  it(`renders the ${label} execution state without inventing a result`, () => {
    render(<ToolCallCard part={{ ...tool, ...patch }} finished={finished} createdAt={timestamp} />)
    expect(screen.getByRole("status")).toHaveTextContent(label)
    expect(screen.getByRole("status").querySelector("time")).toHaveAttribute(
      "dateTime",
      new Date(timestamp).toISOString(),
    )
    expect(screen.queryByText("Resultado")).toBeNull()
    if (label === "Encerrado") expect(screen.getByText("Resultado histórico indisponível.")).toBeVisible()
  })
}

it("gives pending, denied and expired approval states precedence over tool execution", () => {
  const view = render(<ApprovalCard part={approval} tool={{ ...tool, ok: true }} api={createMockApi()} />)
  expect(screen.getByRole("status")).toHaveTextContent("Aguardando aprovação")
  view.rerender(<ApprovalCard part={{ ...approval, decision: "denied" }} tool={tool} />)
  expect(screen.getByText("Negado por você")).toBeVisible()
  expect(view.container.querySelector(".tool-call-card")).toHaveAttribute("data-tool-status", "denied")
  view.rerender(<ApprovalCard part={{ ...approval, decision: "expired" }} tool={tool} />)
  expect(screen.getByText("Aprovação expirada")).toBeVisible()
  expect(screen.queryByRole("button", { name: "Aprovar" })).toBeNull()
})

it("keeps approved execution separate from the decision, including its recorded local time", async () => {
  vi.spyOn(Date, "now").mockReturnValue(timestamp)
  const view = render(<ApprovalCard part={approval} tool={tool} api={createMockApi()} />)
  fireEvent.click(screen.getByRole("button", { name: "Aprovar" }))
  await screen.findByText("Aprovado por você")
  const chip = view.container.querySelector(".tool-decision-chip")
  expect(chip).toHaveTextContent(
    `Aprovado por você · ${new Date(timestamp).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`,
  )
  expect(chip?.querySelector("svg")).toBeInTheDocument()
  expect(view.container.querySelector(".tool-status-chip")).toHaveTextContent("Executando")
})

it.each(["before", "after"] as const)(
  "retains decision time and focuses the closed summary when the server update arrives %s the answer",
  async (order) => {
    const user = userEvent.setup()
    vi.spyOn(Date, "now").mockReturnValue(timestamp)
    const api = createMockApi()
    let resolve: () => void = () => undefined
    api.request = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done
        }),
    ) as ApiRequest
    const props = { api, finished: false, createdAt: timestamp }
    const view = render(<ToolCallList {...props} parts={[tool, approval]} />)
    fireEvent.click(screen.getByRole("button", { name: "Aprovar" }))
    const resolvedParts: MessagePart[] = [tool, { ...approval, decision: "approved" }]
    if (order === "before") view.rerender(<ToolCallList {...props} parts={resolvedParts} />)
    await act(async () => resolve())
    if (order === "after") view.rerender(<ToolCallList {...props} parts={resolvedParts} />)
    expect(view.container.querySelector(".tool-group > summary")).toHaveFocus()
    expect(view.container.querySelector(".tool-group")).not.toHaveAttribute("open")
    expect(view.container.querySelector(".tool-call-card")).toBeNull()
    await user.click(screen.getByText("1 ferramenta"))
    const card = await screen.findByRole("article", { name: "Aprovação de ferramenta" })
    expect(card.querySelector(".tool-decision-chip time")).toHaveAttribute(
      "dateTime",
      new Date(timestamp).toISOString(),
    )
    expect(view.container.querySelectorAll(".tool-call-card")).toHaveLength(1)
  },
)

it.each(["approved", "denied"] as const)(
  "keeps terminal cards collapsed after an approval is %s until the user expands them",
  async (decision) => {
    const user = userEvent.setup()
    const earlier = { ...tool, callId: "earlier", inputJson: '{"command":"pwd"}', ok: true }
    const props = { api: createMockApi(), createdAt: timestamp, finished: false }
    const view = render(<ToolCallList {...props} parts={[earlier, tool, approval]} />)
    expect(view.container.querySelector(".tool-group")).not.toHaveAttribute("open")
    expect(
      within(screen.getByRole("article", { name: "Aprovação de ferramenta" })).getByRole("figure", { name: "Comando" }),
    ).toBeVisible()
    await user.click(screen.getByRole("button", { name: decision === "approved" ? "Aprovar" : "Negar" }))
    await screen.findByText(decision === "approved" ? "Aprovado por você" : "Negado por você")
    const resolved = { ...approval, decision }
    view.rerender(<ToolCallList {...props} parts={[earlier, tool, resolved]} />)
    expect(view.container.querySelector(".tool-group")).not.toHaveAttribute("open")
    expect(screen.queryByText("printf QA_R7_APROVADO")).toBeNull()
    await user.click(screen.getByText("2 ferramentas"))
    const card = await screen.findByRole("article", { name: "Aprovação de ferramenta" })
    const command = within(card).getByRole("figure", { name: "Comando" })
    expect(command).toHaveTextContent("printf QA_R7_APROVADO")
    expect(command).toBeVisible()
    view.rerender(
      <ToolCallList
        {...props}
        parts={[earlier, { ...tool, ok: true, outputJson: "QA_R7_APROVADO" }, resolved]}
        finished
      />,
    )
    expect(view.container.querySelector(".tool-group")).toHaveAttribute("open")
    await user.click(screen.getByText("2 ferramentas"))
    expect(command).not.toBeVisible()
    await user.click(screen.getByText("2 ferramentas"))
    expect(command).toBeVisible()
    expect(within(card).getByRole("figure", { name: "Comando" })).toBe(command)
  },
)

it("mounts completed tool content on first expansion and preserves technical details when reopened", async () => {
  const user = userEvent.setup()
  const view = render(
    <ToolCallList
      parts={[{ ...tool, ok: true, outputJson: '{"result":"Generated result"}' }]}
      finished
      createdAt={timestamp}
    />,
  )
  expect(screen.getByText("1 ferramenta")).toBeVisible()
  expect(view.container.querySelector(".tool-group-cards")).toBeNull()
  expect(view.container.querySelector(".tool-call-card")).toBeNull()
  expect(screen.queryByText("printf QA_R7_APROVADO")).toBeNull()

  await user.click(screen.getByText("1 ferramenta"))
  const card = await screen.findByRole("article", { name: "Ferramenta · Terminal" })
  expect(within(card).getByRole("figure", { name: "Comando" })).toHaveTextContent("printf QA_R7_APROVADO")
  await user.click(within(card).getByText("Detalhes técnicos"))
  expect(card.querySelector(".tool-technical")).toHaveAttribute("open")
  await user.click(screen.getByText("1 ferramenta"))
  expect(card).not.toBeVisible()
  await user.click(screen.getByText("1 ferramenta"))
  expect(screen.getByRole("article", { name: "Ferramenta · Terminal" })).toBe(card)
  expect(card.querySelector(".tool-technical")).toHaveAttribute("open")
  await user.click(within(card).getByText("Resultado"))
  expect(card.querySelector(".tool-output")).toHaveAttribute("open")
  expect(card.querySelector(".tool-output")).toHaveTextContent("Generated result")
})

it.each([
  ["pt-BR", 1, "1 ferramenta"],
  ["pt-BR", 2, "2 ferramentas"],
  ["en", 1, "1 tool"],
  ["en", 2, "2 tools"],
] as const)("localizes the collapsed tool count in %s for %s tools", (locale, count, label) => {
  expect(t("Tool group count", { count }, locale)).toBe(label)
})

it("does not invent a decision timestamp for restored approvals", () => {
  const view = render(<ApprovalCard part={{ ...approval, decision: "approved" }} tool={tool} createdAt={timestamp} />)
  expect(view.container.querySelector(".tool-decision-chip time")).toBeNull()
  expect(screen.getByText("Aprovado por você")).toBeVisible()
})

it("does not deny an approval when Escape is pressed on the card", async () => {
  const user = userEvent.setup()
  const api = createMockApi()
  render(<ApprovalCard part={approval} api={api} />)
  await user.keyboard("{Escape}")
  expect(api.calls).toHaveLength(0)
  screen.getByRole("article", { name: "Aprovação de ferramenta" }).focus()
  await user.keyboard("{Escape}")
  expect(api.calls).toHaveLength(0)
  expect(screen.getByRole("button", { name: "Aprovar" })).toBeVisible()
})

it("preserves Enter on action buttons and disclosure summaries instead of approving accidentally", async () => {
  const user = userEvent.setup()
  const api = createMockApi()
  render(<ApprovalCard part={approval} api={api} />)
  screen.getByText("Detalhes técnicos").focus()
  await user.keyboard("{Enter}")
  expect(api.calls).toHaveLength(0)
  screen.getByRole("button", { name: "Negar" }).focus()
  await user.keyboard("{Enter}")
  expect(api.calls[0]?.input).toEqual({ decision: "denied", standing: false })
})

it("disables all decisions while sending, prevents duplicate answers, and recovers after failure", async () => {
  const api = createMockApi()
  let reject: (reason: Error) => void = () => undefined
  const request = vi.fn(
    () =>
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise
      }),
  )
  api.request = request as ApiRequest
  render(<ApprovalCard part={approval} api={api} />)
  const card = screen.getByRole("article", { name: "Aprovação de ferramenta" })
  const approve = within(card).getByRole("button", { name: "Aprovar" })
  fireEvent.click(approve)
  fireEvent.click(approve)
  expect(request).toHaveBeenCalledTimes(1)
  for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled()
  await act(async () => reject(new Error("Falha de conexão")))
  expect(screen.getByRole("alert")).toHaveTextContent("Falha de conexão")
  expect(screen.getByRole("button", { name: "Aprovar" })).toBeEnabled()
  expect(screen.getByRole("button", { name: "Negar" })).toBeEnabled()
})

it("shows the standing grant scope after a separate confirmation step", () => {
  const view = render(
    <ApprovalCard
      part={{ ...approval, scope: { source: "mcp", server: "docs", tool: "save" } }}
      api={createMockApi()}
    />,
  )
  fireEvent.click(screen.getByRole("button", { name: "Permitir sempre nesta ferramenta" }))
  expect(screen.getByText(/A ferramenta docs · save poderá agir neste bot/)).toBeVisible()
  expect(screen.getByRole("button", { name: /Sim, permitir .* neste bot sem perguntar de novo/ })).toBeVisible()
  view.rerender(<ApprovalCard part={{ ...approval, allowStanding: false }} api={createMockApi()} />)
  expect(screen.queryByRole("button", { name: "Permitir sempre nesta ferramenta" })).toBeNull()
})

it("groups two completed calls inside one disclosure and keeps matched pending approvals outside it", async () => {
  const user = userEvent.setup()
  const second = { ...tool, callId: "bash-2", inputJson: '{"command":"pwd"}', ok: true }
  const pendingTool = { ...tool, callId: "bash-3", inputJson: '{"command":"date"}' }
  const pendingApproval = { ...approval, detail: `Bash: ${pendingTool.inputJson}` }
  const view = render(
    <ToolCallList
      parts={[{ ...tool, ok: true }, second, pendingTool, pendingApproval]}
      api={createMockApi()}
      finished={false}
      createdAt={timestamp}
    />,
  )
  const group = view.container.querySelector(".tool-group")
  expect(group?.querySelectorAll(".tool-call-card")).toHaveLength(0)
  expect(group?.querySelector("[data-approval-id]")).toBeNull()
  expect(screen.getByRole("button", { name: "Aprovar" })).toBeVisible()
  expect(view.container.querySelectorAll(".tool-call-card")).toHaveLength(1)
  await user.click(screen.getByText("2 ferramentas"))
  expect(screen.getByText("pwd")).toBeVisible()
  expect(group?.querySelectorAll(".tool-call-card")).toHaveLength(2)
  expect(view.container.querySelectorAll(".tool-call-card")).toHaveLength(3)
  expect(screen.getAllByText("Terminal")).toHaveLength(3)
})

it("does not merge tool groups across text or attach approval to a different same-named call", () => {
  const parts: MessagePart[] = [
    tool,
    { type: "text", text: "Outra etapa" },
    { ...tool, callId: "bash-2", inputJson: '{"command":"pwd"}' },
    approval,
  ]
  const view = render(<ToolCallList parts={parts} api={createMockApi()} finished={false} createdAt={timestamp} />)
  const pending = screen.getByRole("article", { name: "Aprovação de ferramenta" })
  expect(pending).toHaveAttribute("data-call-id", tool.callId)
  expect(pending).not.toHaveTextContent("pwd")
  expect(view.container.querySelectorAll(".tool-turn")).toHaveLength(2)
})

it("matches provider envelopes by arguments independent of object key order, not just tool name", () => {
  expect(
    approvalMatchesTool(
      {
        ...approval,
        detail:
          'Bash: "{\\"description\\":\\"Imprimir marcador aprovado\\",\\"command\\":\\"printf QA_R7_APROVADO\\"}"',
      },
      tool,
    ),
  ).toBe(true)
  expect(approvalMatchesTool({ ...approval, detail: 'Bash: {"command":"rm -rf ./other"}' }, tool)).toBe(false)
  expect(
    approvalMatchesTool(
      { ...approval, scope: { source: "mcp", server: "wrong", tool: "save" }, detail: "{}" },
      { ...tool, tool: "mcp__docs__save", inputJson: "{}" },
    ),
  ).toBe(false)
})

it("collapses output separately and pretty prints structured JSON results", async () => {
  const user = userEvent.setup()
  const view = render(<ToolCallCard part={{ ...tool, ok: true, outputJson: '{"count":2,"items":["um","dois"]}' }} />)
  const output = view.container.querySelector(".tool-output")
  expect(output).not.toHaveAttribute("open")
  await user.click(screen.getByText("Resultado"))
  expect(output).toHaveAttribute("open")
  expect(output?.querySelector("code")?.textContent).toBe(
    '{\n  "count": 2,\n  "items": [\n    "um",\n    "dois"\n  ]\n}',
  )
})

it("truncates long output with an accessible control to reveal the rest", async () => {
  const user = userEvent.setup()
  const view = render(<ToolCallCard part={{ ...tool, ok: true, outputJson: `${"linha\n".repeat(240)}FIM` }} />)
  await user.click(screen.getByText("Resultado"))
  const output = view.container.querySelector(".tool-output")
  expect(output).not.toHaveTextContent("FIM")
  await user.click(screen.getByRole("button", { name: "Mostrar saída completa" }))
  expect(output).toHaveTextContent("FIM")
  expect(screen.getByRole("button", { name: "Recolher saída" })).toHaveAttribute("aria-expanded", "true")
})

it("localizes tool descriptions in the summary, technical input and structured output", () => {
  const view = render(
    <ToolCallCard
      part={{
        ...tool,
        inputJson: '{"command":"date","description":"Show current time"}',
        outputJson: '{"description":"Show current time","command":"date"}',
        ok: true,
      }}
    />,
  )
  expect(view.container.querySelector(".tool-summary")).toHaveTextContent("Mostrar a hora atual")
  expect(view.container.querySelector(".tool-technical")).toHaveTextContent('"description": "Mostrar a hora atual"')
  expect(view.container.querySelector(".tool-output")).toHaveTextContent('"description": "Mostrar a hora atual"')
  expect(view.container).not.toHaveTextContent("Show current time")
  expect(screen.getByRole("figure", { name: "Comando" })).toHaveTextContent(/^date$/)
})

for (const envelope of [
  [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
  [{ type: "image", source: { type: "base64", data: "aGVsbG8=", media_type: "image/png" } }],
  [
    {
      type: "text",
      text: JSON.stringify({ success: true, content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] }),
    },
  ],
]) {
  it("renders computer screenshots as accessible thumbnails without printing base64", () => {
    const view = render(
      <ToolCallCard part={{ ...tool, tool: "computer_screenshot", ok: true, outputJson: JSON.stringify(envelope) }} />,
    )
    expect(screen.getByRole("button", { name: "Abrir captura 1 em tamanho original" })).toBeVisible()
    expect(screen.queryByRole("link", { name: "Baixar imagem" })).toBeNull()
    expect(screen.getByRole("button", { name: "Baixar imagem" })).toBeVisible()
    expect(view.container.querySelector(".tool-output")).toBeNull()
    expect(view.container).not.toHaveTextContent("aGVsbG8=")
  })
}

it("preserves commands verbatim while redacting credentials in every display, including technical details", () => {
  const view = render(
    <ToolCallCard
      part={{
        ...tool,
        inputJson: JSON.stringify({ command: 'curl --token private-token "$HOME/a b"', apiKey: "private-api-key" }),
      }}
    />,
  )
  expect(screen.getByRole("figure", { name: "Comando" })).toHaveTextContent('curl --token [REDACTED] "$HOME/a b"')
  expect(view.container).not.toHaveTextContent("private-token")
  expect(view.container).not.toHaveTextContent("private-api-key")
})

it("keeps malformed or partial JSON out of the summary and readable parameters", () => {
  const view = render(
    <ToolCallCard part={{ ...tool, tool: "browser_navigate", inputJson: '{"url":"https://example.test"' }} />,
  )
  expect(view.container.querySelector(".tool-summary")).not.toHaveTextContent("{")
  expect(screen.getByRole("figure", { name: "Parâmetros" })).toHaveTextContent("Parâmetros incompletos.")
})

for (const [exitCode, label] of [
  [null, "Executando"],
  [0, "Concluído"],
  [1, "Erro"],
] as const) {
  it(`renders native commands with exit ${exitCode} as ${label}`, () => {
    const part: ToolPart = { type: "command", callId: "cmd", command: "pwd", cwd: "/project", outputTail: "", exitCode }
    render(<ToolCallCard part={part} />)
    expect(screen.getByRole("status")).toHaveTextContent(label)
    expect(screen.getByRole("figure", { name: "Comando" })).toHaveTextContent(/^pwd$/)
  })
}

it("renders file changes in the same card family with collapsible diff", () => {
  render(
    <ToolCallCard
      part={{
        type: "file_change",
        callId: "edit",
        paths: ["README.md"],
        diff: "+ atualizado",
        resolution: "succeeded",
      }}
    />,
  )
  expect(screen.getByText("Arquivos")).toBeVisible()
  expect(screen.getByRole("list", { name: "Arquivos" })).toHaveTextContent("README.md")
  expect(screen.getByRole("status")).toHaveTextContent("Concluído")
  expect(within(screen.getByRole("article", { name: "Ferramenta · Arquivos" })).getByText("Resultado")).toBeVisible()
})

it("keeps README fences and HTML literal in diffs and the explanation outside code", async () => {
  const diff = "diff --git a/README.md b/README.md\n@@ -1,3 +1,4 @@\n ```js\n+<b>literal</b>\n ```\n+``````"
  const view = render(<MarkdownContent content={`\`\`\`diff\n${diff}\n\`\`\`\n\nExplicação depois do diff.`} />)
  const explanation = await screen.findByText("Explicação depois do diff.")
  expect(explanation.closest("pre, code")).toBeNull()
  expect(view.container.querySelector("pre code")?.textContent).toBe(diff)
  expect(view.container.querySelector("b")).toBeNull()
  expect(fenceCode(diff, "diff").split("\n")[0]).toBe("```````diff")
  view.unmount()
  const toolView = render(<ToolCallCard part={{ type: "file_change", callId: "readme", paths: ["README.md"], diff }} />)
  expect(toolView.container.querySelector(".tool-output pre code")?.textContent).toBe(diff)
})

it("shows each consecutive approval's own request time in a shared message", () => {
  const later = timestamp + 120_000
  const view = render(
    <ToolCallList parts={[{ ...approval, createdAt: timestamp }]} createdAt={timestamp - 60_000} finished={false} />,
  )
  expect(view.container.querySelector("time")?.dateTime).toBe(new Date(timestamp).toISOString())
  view.rerender(
    <ToolCallList
      parts={[
        { ...approval, createdAt: timestamp, decision: "approved" },
        { ...approval, approvalId: "next", createdAt: later },
      ]}
      createdAt={timestamp - 60_000}
      finished={false}
    />,
  )
  expect(view.container.querySelector('[data-approval-id="next"] time')?.getAttribute("datetime")).toBe(
    new Date(later).toISOString(),
  )
})

it("preserves an unobserved failed file change when the interrupted turn is replayed", () => {
  render(
    <ToolCallCard
      part={{
        type: "file_change",
        callId: "edit",
        paths: ["arquivo.txt"],
        diff: null,
        resolution: "completed_unobserved",
        completedOutcome: "failed",
      }}
    />,
  )
  expect(screen.getByRole("status")).toHaveTextContent("Erro")
})

it("never approves on Enter on the card or either approval button", async () => {
  const user = userEvent.setup()
  const api = createMockApi()
  const request = vi.fn((_route: string, _input: unknown) => new Promise(() => undefined))
  api.request = request as ApiRequest
  render(<ApprovalCard part={approval} api={api} />)
  const card = screen.getByRole("article", { name: "Aprovação de ferramenta" })
  card.focus()
  fireEvent.keyDown(card, { key: "Enter" })
  fireEvent.keyDown(card, { key: "Enter", repeat: true })
  for (const name of ["Aprovar", "Permitir sempre nesta ferramenta"]) {
    screen.getByRole("button", { name }).focus()
    await user.keyboard("{Enter}")
  }
  expect(request).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Aprovar" }))
  expect(request).toHaveBeenCalledTimes(1)
  expect(request.mock.calls[0]?.[1]).toMatchObject({ decision: "approved" })
})

it.each([
  ["pt-BR", "Baixar imagem"],
  ["en", "Download image"],
] as const)("translates the screenshot save action in %s", (locale, label) => {
  expect(t("Baixar imagem", {}, locale)).toBe(label)
})

it("saves the original screenshot as approved-1.png only after the computer card's save button is clicked", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="
  const invoke = vi.fn(async (_command: string, _args: unknown) => ({ path: "/tmp/approved-1.png" }))
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke })
  try {
    render(
      <ToolCallCard
        part={{
          ...tool,
          callId: "approved",
          tool: "computer_screenshot",
          ok: true,
          outputJson: JSON.stringify([{ type: "image", data: png, mimeType: "image/png" }]),
        }}
      />,
    )
    const card = within(screen.getByRole("article", { name: "Ferramenta · Computador" }))
    expect(card.getByRole("button", { name: "Abrir captura 1 em tamanho original" })).toBeVisible()
    expect(card.queryByRole("link", { name: "Baixar imagem" })).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
    fireEvent.click(card.getByRole("button", { name: "Baixar imagem" }))
    expect(await card.findByText("Salvo em /tmp/approved-1.png")).toBeVisible()
    expect(invoke).toHaveBeenCalledExactlyOnceWith("save_file", { name: "approved-1.png", dataBase64: png }, undefined)
  } finally {
    vi.unstubAllGlobals()
  }
})
