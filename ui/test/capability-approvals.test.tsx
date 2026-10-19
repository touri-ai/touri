import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ApprovalPart, ToolCallPart } from "@touri/contracts"
import { approvalSummary } from "@touri/contracts/approval-summary"
import { afterEach, expect, it } from "vitest"
import { createMockApi } from "../src/api/mock"
import { ApprovalCard } from "../src/components/ApprovalCard"
import { ToolCallList } from "../src/components/ToolCallList"
import { approvalMatchesTool } from "../src/components/toolPresentation"
import { t } from "../src/i18n"

afterEach(cleanup)
const input = {
  capability: "browser",
  reason: "abrir a página solicitada",
  botName: "Lia",
  machine: "local",
  hostComputerUse: false,
}
const approval = (fields = input): ApprovalPart => ({
  type: "approval",
  approvalId: "capability",
  botId: "b",
  request: "permission",
  scope: { source: "mcp", server: "touri", tool: "capability_request" },
  detail: `capability_request: ${JSON.stringify(fields)}`,
  allowStanding: false,
  decision: "pending",
})
const tool: ToolCallPart = {
  type: "tool_call",
  callId: "request",
  tool: "mcp__touri__capability_request",
  summary: "capability_request",
  inputJson: JSON.stringify({ capability: input.capability, reason: input.reason }),
  outputJson: null,
  ok: null,
}

it("merges the enriched approval with the tool and requires an explicit activation click", async () => {
  const api = createMockApi()
  render(<ToolCallList parts={[tool, approval()]} api={api} finished={false} createdAt={1} />)
  expect(screen.getAllByText("Ativar navegador")).toHaveLength(1)
  expect(screen.getByText(/Lia quer ativar o navegador dele para abrir a página solicitada/)).toBeVisible()
  expect(screen.queryByRole("button", { name: "Permitir sempre nesta ferramenta" })).not.toBeInTheDocument()
  const enable = screen.getByRole("button", { name: "Ativar", exact: true })
  fireEvent.keyDown(enable, { key: "Enter" })
  expect(api.calls).toHaveLength(0)
  fireEvent.click(enable)
  await screen.findByText("Aprovado por você")
  expect(api.calls).toContainEqual({
    route: "POST /approvals/:id",
    input: { decision: "approved", standing: false },
    pathValues: { id: "capability" },
  })
})

it("not now returns a denial", async () => {
  const api = createMockApi()
  render(<ApprovalCard part={approval()} api={api} />)
  fireEvent.click(screen.getByRole("button", { name: "Agora não" }))
  await screen.findByText("Negado por você")
  expect(api.calls).toContainEqual({
    route: "POST /approvals/:id",
    input: { decision: "denied", standing: false },
    pathValues: { id: "capability" },
  })
})

it("computer control describes its screen boundary and never offers standing consent", () => {
  render(
    <ApprovalCard
      part={{ ...approval({ ...input, capability: "computer_use", machine: "vm" }), allowStanding: true }}
      api={createMockApi()}
    />,
  )
  expect(screen.getByText("Ativar controle do computador")).toBeVisible()
  expect(screen.getByText(/Controla somente a tela do computador isolado do bot/)).toBeVisible()
  expect(screen.getByText(/Pode ver a tela e clicar ou digitar, somente onde o touri permite/)).toBeVisible()
  expect(screen.queryByRole("button", { name: "Permitir sempre nesta ferramenta" })).not.toBeInTheDocument()
})

it.each([
  "capability_request: null",
  'capability_request: {"capability":"browser","reason":"truncated',
  'capability_request: {"capability":"all"}',
])("unreadable capability reviews cannot be approved: %s", (detail) => {
  render(<ApprovalCard part={{ ...approval(), detail }} tool={tool} api={createMockApi()} />)
  expect(screen.getByText("Detalhes indisponíveis")).toBeVisible()
  expect(screen.getByRole("button", { name: /Aprovar|Ativar/, exact: true })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Agora não" })).toBeEnabled()
})

it("matches the reviewed capability and reason but rejects external impersonation", () => {
  expect(approvalMatchesTool(approval(), tool)).toBe(true)
  expect(approvalMatchesTool(approval({ ...input, capability: "computer_use" }), tool)).toBe(false)
  expect(approvalMatchesTool(approval({ ...input, reason: "outra tarefa" }), tool)).toBe(false)
  expect(
    approvalMatchesTool(
      { ...approval(), scope: { source: "mcp", server: "external", tool: "capability_request" } },
      tool,
    ),
  ).toBe(false)
})

it("has Portuguese and English copy for the full review and actions", () => {
  expect(t("Ativar", {}, "en")).toBe("Enable")
  expect(t("Agora não", {}, "en")).toBe("Not now")
  const pt = approvalSummary(approval(), "pt-BR")
  const en = approvalSummary(approval(), "en")
  expect(pt.title).toBe("Ativar navegador")
  expect(en.title).toBe("Enable browser")
  expect(en.body).toContain("Lia wants to enable its browser")
  expect(en.body).toContain("isolated browser")
  expect(en.body).toContain("resumes the task automatically")
  expect(approvalSummary(approval({ ...input, capability: "computer_use" }), "en").body).toContain(
    "only where touri allows",
  )
  for (const key of [
    "Abre páginas no navegador isolado deste bot.",
    "Pode ver a tela e clicar ou digitar, somente onde o touri permite.",
    "Após ativar, o touri retoma a tarefa automaticamente.",
  ] as const) {
    expect(t(key, {}, "pt-BR")).toBe(key)
    expect(t(key, {}, "en")).not.toBe(key)
  }
})
