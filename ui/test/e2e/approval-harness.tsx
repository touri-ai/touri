import type { ApprovalPart, Message, ToolCallPart } from "@touri/contracts"
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { createMockApi } from "../../src/api/mock"
import { ApprovalCard } from "../../src/components/ApprovalCard"
import { VirtualMessageList } from "../../src/components/ChatPanel"
import { ToolCallCard } from "../../src/components/ToolCallCard"
import "../../src/styles.css"

const api = createMockApi()
const timestamp = new Date("2026-10-13T20:21:00Z").getTime()
const call = (id: string, marker: string, description: string, ok: boolean | null): ToolCallPart => ({
  type: "tool_call",
  callId: id,
  tool: "Bash",
  summary: "Ferramenta Bash",
  inputJson: JSON.stringify({ command: `printf ${marker}`, description }),
  outputJson: ok ? marker : null,
  ok,
  ...(ok ? { resolvedAt: timestamp + 2000 } : {}),
})
const approval = (id: string, tool: ToolCallPart, decision: ApprovalPart["decision"]): ApprovalPart => ({
  type: "approval",
  approvalId: id,
  request: "permission",
  detail: `Bash: ${tool.inputJson}`,
  scope: { source: "mcp", tool: "Bash" },
  allowStanding: true,
  decision,
})
const approved = call("approved", "QA_R7_APROVADO", "Imprimir marcador de teste aprovado", true)
const pending = call("pending", "QA_R7_NEGADO", "Imprimir marcador de teste pendente", null)
const read: ToolCallPart = {
  ...pending,
  callId: "read",
  tool: "Read",
  summary: "Ferramenta de leitura",
  inputJson: '{"file_path":"/workspace/demo/README.md"}',
}
const scenario = new URLSearchParams(location.search).get("scene") ?? "bash"
const message: Message = {
  id: "approval-scene",
  threadId: "approval-thread",
  parentId: null,
  role: "assistant",
  kind: "tool",
  status: "streaming",
  runId: null,
  text: "",
  parts:
    scenario === "thinking"
      ? [{ type: "reasoning", text: "Vou conferir os arquivos do projeto." }]
      : scenario === "read"
        ? [
            read,
            {
              ...approval("pending", read, "pending"),
              detail: `Read: ${read.inputJson}`,
              scope: { source: "mcp", tool: "Read" },
            },
          ]
        : [approved, approval("approved", approved, "approved"), pending, approval("pending", pending, "pending")],
  sender: null,
  source: "local",
  createdAt: timestamp,
  updatedAt: timestamp,
}

const root = document.getElementById("root")
const States = () => {
  const [image, setImage] = useState<string>()
  const loadImage = async () => {
    const blob = await (await fetch("/touri-bull.png")).blob()
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === "string") setImage(reader.result.split(",")[1])
    }
    reader.readAsDataURL(blob)
  }
  return (
    <main aria-label="Estados das ferramentas" style={{ padding: 24, height: "100%", overflow: "auto" }}>
      <h1 className="visually-hidden">Estados das ferramentas</h1>
      <div style={{ maxWidth: 800, margin: "0 auto", display: "grid", gap: 16 }}>
        <ToolCallCard
          part={{
            ...approved,
            tool: "browser_navigate",
            inputJson: '{"url":"https://example.test","description":"Abrir a página de referência"}',
            ok: null,
            outputJson: null,
          }}
          createdAt={timestamp}
        />
        <ApprovalCard part={approval("denied", pending, "denied")} tool={pending} createdAt={timestamp} />
        <ToolCallCard
          part={{ ...pending, ok: false, outputJson: "O comando terminou com código 1." }}
          createdAt={timestamp}
        />
        <ToolCallCard part={pending} finished createdAt={timestamp} />
        <ToolCallCard
          part={{
            ...approved,
            tool: "mcp__docs__save",
            inputJson: '{"name":"relatorio.md","description":"Salvar o relatório no projeto"}',
            outputJson: '{"saved":true,"path":"relatorio.md"}',
          }}
          createdAt={timestamp}
        />
        <button type="button" className="tool-action tool-action-secondary" onClick={() => void loadImage()}>
          Carregar captura de teste
        </button>
        {image && (
          <ToolCallCard
            part={{
              ...approved,
              tool: "computer_screenshot",
              inputJson: '{"maxWidth":1440,"description":"Capturar a tela do computador"}',
              outputJson: JSON.stringify([{ type: "image", data: image, mimeType: "image/png" }]),
            }}
            createdAt={timestamp}
          />
        )}
      </div>
    </main>
  )
}
if (root)
  createRoot(root).render(
    new URLSearchParams(location.search).has("states") ? (
      <States />
    ) : (
      <main style={{ maxWidth: 800, margin: "40px auto", padding: 24 }}>
        <h1 className="visually-hidden">Ferramentas e aprovações</h1>
        <VirtualMessageList
          messages={[message]}
          api={api}
          onSwitchBranch={() => undefined}
          onRetry={async () => undefined}
        />
      </main>
    ),
  )
