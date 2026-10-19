import { cleanup, render, screen } from "@testing-library/react"
import type { ApprovalPart, CommandPart } from "@touri/contracts"
import { afterEach, expect, it } from "vitest"
import { createMockApi } from "../src/api/mock"
import { ApprovalCard } from "../src/components/ApprovalCard"
import { ToolCallList } from "../src/components/ToolCallList"

afterEach(cleanup)

const definition = (label: string) => screen.getByText(label, { selector: "dt" }).nextElementSibling

const approval = (request: ApprovalPart["request"], input: unknown): ApprovalPart => ({
  type: "approval",
  approvalId: "review",
  request,
  decision: "pending",
  detail: JSON.stringify(input),
})

it("shows the command, working folder, sandbox reason and requested access before approval", () => {
  const part = approval("command", {
    command: "bun test --filter approval",
    cwd: "/workspace/project",
    reason: "Sandbox failed to start; retry without sandbox?",
    additionalPermissions: { fileSystem: { read: ["/workspace/docs"], write: ["/workspace/project"] }, network: true },
    threadId: "private-thread",
    turnId: "private-turn",
    itemId: "private-item",
    startedAtMs: 12345,
  })
  const tool: CommandPart = {
    type: "command",
    callId: "command",
    command: "bun test --filter approval",
    cwd: "/workspace/project",
    exitCode: null,
    outputTail: "",
  }
  const view = render(<ApprovalCard part={part} tool={tool} api={createMockApi()} />)
  expect(screen.getByRole("figure", { name: "Comando" })).toHaveTextContent("bun test --filter approval")
  expect(
    screen.getByText("O isolamento (sandbox) falhou ao iniciar. O Codex quer executar este comando sem isolamento."),
  ).toBeVisible()
  expect(definition("Pasta de trabalho")).toHaveTextContent("/workspace/project")
  expect(definition("Leitura")).toHaveTextContent("/workspace/docs")
  expect(definition("Escrita")).toHaveTextContent("/workspace/project")
  expect(definition("Rede")).toHaveTextContent("Permitida")
  expect(view.container.querySelector(".tool-technical")).toHaveTextContent("Sandbox failed to start")
  expect(view.container.textContent).not.toMatch(/private-thread|private-turn|private-item|startedAtMs|12345/)
})

it("shows create, change and delete targets with a compact literal diff before approval", () => {
  const diff = `@@ -1 +1 @@\n-old\n+<b>new</b>\n${"+line\n".repeat(30)}`
  const view = render(
    <ApprovalCard
      api={createMockApi()}
      part={approval("file_change", {
        cwd: "/workspace/project",
        reason: "Update project documentation",
        grantRoot: "/workspace/project",
        changes: [
          { path: "new.md", kind: "add", diff: "+hello" },
          { path: "README.md", kind: { type: "update" }, diff },
          { path: "old.md", kind: "delete", diff: "-old" },
        ],
      })}
    />,
  )
  const files = screen.getByRole("list", { name: "Arquivos" })
  expect(files).toHaveTextContent("Criar new.md")
  expect(files).toHaveTextContent("Alterar README.md")
  expect(files).toHaveTextContent("Excluir old.md")
  expect(screen.getByText("Update project documentation")).toBeVisible()
  const preview = screen.getAllByRole("figure", { name: /Prévia das alterações/ })[1]
  expect(preview).toHaveTextContent("+<b>new</b>")
  expect(preview?.textContent?.length).toBeLessThan(diff.length)
  expect(view.container.querySelector("b")).toBeNull()
  expect(definition("Pasta autorizada para alterações")).toHaveTextContent("/workspace/project")
  expect(view.container.querySelector(".tool-technical")).not.toHaveAttribute("open")
})

it("states explicitly when Codex supplies no file list or network scope", () => {
  const view = render(
    <ApprovalCard
      api={createMockApi()}
      part={approval("file_change", {
        reason: "command failed; retry without sandbox?",
        grantRoot: null,
        threadId: "internal-thread",
        itemId: "internal-item",
      })}
    />,
  )
  expect(screen.getByText("O Codex não informou quais arquivos serão alterados.")).toBeVisible()
  expect(screen.getByText("O comando falhou. O Codex quer tentar novamente sem isolamento (sandbox).")).toBeVisible()
  expect(screen.queryByText("Rede", { selector: "dt" })).toBeNull()
  expect(screen.queryByText(/Não informada/)).toBeNull()
  expect(screen.queryByRole("list", { name: "Arquivos" })).toBeNull()
  expect(view.container.querySelector(".tool-input")).toBeNull()
  expect(view.container.textContent).not.toMatch(/grantRoot:|internal-thread|internal-item|reason:/)
})

it("previews a supplied diff even when the provider omits its file list", () => {
  render(<ApprovalCard part={approval("file_change", { diff: "-old\n+new" })} api={createMockApi()} />)
  expect(screen.getByText("O Codex não informou quais arquivos serão alterados.")).toBeVisible()
  expect(screen.getByRole("figure", { name: "Prévia das alterações" })).toHaveTextContent("-old +new")
})

it("collapses missing details into one quiet line instead of five empty rows", () => {
  const view = render(<ApprovalCard part={approval("file_change", {})} api={createMockApi()} />)
  expect(screen.getByText("O provedor não detalhou o pedido")).toBeVisible()
  expect(view.container.querySelector("dl")).toBeNull()
  expect(view.container.textContent).not.toMatch(/Não informada|não informou o motivo/)
})

it("drops the detail rows once the request is decided", () => {
  const part = { ...approval("file_change", { cwd: "/workspace/project" }), decision: "approved" as const }
  const view = render(<ApprovalCard part={part} api={createMockApi()} />)
  expect(view.container.querySelector("dl")).toBeNull()
  expect(screen.queryByText("O provedor não detalhou o pedido")).toBeNull()
})

it("explains permission-only requests with read/write and network scope in plain words", () => {
  render(
    <ApprovalCard
      part={approval("permission", {
        reason: "Consultar a documentação",
        permissions: {
          fileSystem: { read: ["/workspace/docs"], write: [] },
          network: { enabled: true },
        },
      })}
      api={createMockApi()}
    />,
  )
  expect(screen.getByText("Permitir os acessos solicitados")).toBeVisible()
  expect(screen.getByText("Consultar a documentação")).toBeVisible()
  expect(definition("Leitura")).toHaveTextContent("/workspace/docs")
  expect(definition("Escrita")).toHaveTextContent("Nenhuma pasta solicitada")
  expect(definition("Rede")).toHaveTextContent("Permitida")
  expect(screen.queryByRole("figure", { name: "Parâmetros" })).toBeNull()
})

for (const [tool, input, action] of [
  ["Read", { file_path: "README.md" }, "Ler"],
  ["Write", { file_path: "new.md", content: "hello\n" }, "Criar ou substituir"],
  ["Edit", { file_path: "README.md", old_string: "old", new_string: "new" }, "Alterar"],
] as const) {
  it(`renders Claude ${tool} approval with the target and supplied preview`, () => {
    const view = render(
      <ApprovalCard
        part={{
          ...approval(tool === "Read" ? "permission" : "file_change", {
            ...input,
            approvalContext: { cwd: "/workspace/project", reason: "Conferir o documento" },
          }),
          scope: { source: "claude", tool },
        }}
        api={createMockApi()}
      />,
    )
    expect(screen.getByRole("list", { name: "Arquivos" })).toHaveTextContent(`${action} ${input.file_path}`)
    expect(screen.getByText("Conferir o documento")).toBeVisible()
    expect(definition("Pasta de trabalho")).toHaveTextContent("/workspace/project")
    if (tool !== "Read") expect(screen.getByRole("figure", { name: /Prévia das alterações/ })).toBeVisible()
    expect(view.container.querySelector(".tool-input")).toBeNull()
  })
}

it("keeps enriched Claude approvals attached to their original tool call", () => {
  const input = { file_path: "README.md", old_string: "old", new_string: "new" }
  const view = render(
    <ToolCallList
      api={createMockApi()}
      finished={false}
      createdAt={0}
      parts={[
        {
          type: "tool_call",
          callId: "edit",
          tool: "Edit",
          summary: "Claude tool Edit",
          inputJson: JSON.stringify(input),
          outputJson: null,
          ok: null,
        },
        {
          ...approval("file_change", { ...input, approvalContext: { cwd: "/workspace/project" } }),
          scope: { source: "claude", tool: "Edit" },
        },
      ]}
    />,
  )
  expect(view.container.querySelectorAll(".tool-call-card")).toHaveLength(1)
  expect(screen.getByRole("figure", { name: /Prévia das alterações/ })).toHaveTextContent("-old +new")
})

it("keeps Codex changes and their approval in one card while retaining the reason", () => {
  const diff = "@@ -1 +1 @@\n-old\n+new"
  const view = render(
    <ToolCallList
      api={createMockApi()}
      finished={false}
      createdAt={0}
      parts={[
        { type: "file_change", callId: "edit", paths: ["README.md"], diff },
        approval("file_change", {
          changes: [{ path: "README.md", kind: "update", diff }],
          reason: "Atualizar o documento",
        }),
      ]}
    />,
  )
  expect(view.container.querySelectorAll(".tool-call-card")).toHaveLength(1)
  expect(screen.getByText("Atualizar o documento")).toBeVisible()
  expect(screen.getByRole("figure", { name: /Prévia das alterações/ })).toBeVisible()
})
