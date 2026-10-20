import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ApprovalPart, ToolCallPart } from "@touri/contracts"
import { approvalSummary } from "@touri/contracts/approval-summary"
import { afterEach, expect, it } from "vitest"
import { createMockApi } from "../src/api/mock"
import { ApprovalCard } from "../src/components/ApprovalCard"
import { ToolCallList } from "../src/components/ToolCallList"
import { approvalMatchesTool } from "../src/components/toolPresentation"
import { t } from "../src/i18n"

afterEach(cleanup)

const approval = (tool: string, input: unknown): ApprovalPart => ({
  type: "approval",
  approvalId: "setup-approval",
  botId: "bot-a",
  request: "permission",
  scope: { source: "mcp", server: "touri", tool },
  detail: `${tool}: ${JSON.stringify(input)}`,
  allowStanding: false,
  decision: "pending",
})

it("local folder approval explains when access applies in plain language", () => {
  render(
    <ApprovalCard
      api={createMockApi()}
      part={approval("folder_access_request", {
        path: "/tmp/notes",
        mode: "read-write",
        nextTurn: true,
        machine: "local",
      })}
    />,
  )
  expect(
    screen.getByText("Permitir Leitura e escrita em /tmp/notes para este bot. Vale a partir da próxima mensagem."),
  ).toBeInTheDocument()
})

it.each([
  ["local", "Vale a partir da próxima mensagem.", "Takes effect from the next message."],
  ["vm", "Vale a partir da próxima mensagem na VM.", "Takes effect from the next message in the VM."],
] as const)("keeps %s approval timing consistent in Portuguese and English", (machine, portuguese, english) => {
  const part = approval("folder_access_request", { path: "/workspace/notes", mode: "read", nextTurn: true, machine })
  expect(approvalSummary(part).body).toBe(`Permitir Somente leitura em /workspace/notes para este bot. ${portuguese}`)
  expect(approvalSummary(part, "en").body).toBe(`Allow Read-only in /workspace/notes for this bot. ${english}`)
  expect(t(portuguese)).toBe(portuguese)
  expect(t(portuguese, {}, "en")).toBe(english)
})

it("project approval shows the reviewed project and replaced project, even when the provider passed only an ID", async () => {
  const api = createMockApi()
  const tool: ToolCallPart = {
    type: "tool_call",
    callId: "link",
    tool: "mcp__touri__project_link",
    summary: "project_link",
    inputJson: '{"projectId":"project-id"}',
    outputJson: null,
    ok: null,
  }
  render(
    <ApprovalCard
      api={api}
      tool={tool}
      part={approval("project_link", {
        path: "/workspace/javascript/Hodler",
        name: "Hodler",
        previousProject: { name: "Anterior", path: "/workspace/Anterior" },
      })}
    />,
  )
  expect(screen.getByText("Vincular projeto")).toBeInTheDocument()
  expect(
    screen.getByText(
      "Vincular Hodler (/workspace/javascript/Hodler) a este bot Substitui o projeto Anterior (/workspace/Anterior).",
    ),
  ).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Permitir sempre nesta ferramenta" })).toBeNull()
  const card = screen.getByRole("article", { name: "Aprovação de ferramenta" })
  fireEvent.keyDown(card, { key: "Enter" })
  const approve = screen.getByRole("button", { name: "Aprovar" })
  expect(fireEvent.keyDown(approve, { key: "Enter" })).toBe(false)
  expect(fireEvent.keyDown(approve, { key: " " })).toBe(false)
  expect(api.calls).toEqual([])
  fireEvent.click(approve)
  await screen.findByText("Aprovado por você")
  expect(api.calls).toContainEqual({
    route: "POST /approvals/:id",
    input: { decision: "approved", standing: false },
    pathValues: { id: "setup-approval" },
  })
})

for (const [mode, label] of [
  ["read", "Somente leitura"],
  ["read-write", "Leitura e escrita"],
] as const) {
  it(`folder approval shows ${label}, the canonical path and VM timing; Escape leaves it pending`, async () => {
    const api = createMockApi()
    render(
      <ApprovalCard
        api={api}
        part={approval("folder_access_request", { path: "/workspace/Documents", mode, nextTurn: true })}
      />,
    )
    expect(screen.getByText("Conceder acesso à pasta")).toBeInTheDocument()
    expect(
      screen.getByText(
        `Permitir ${label} em /workspace/Documents para este bot. Vale a partir da próxima mensagem na VM.`,
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Permitir sempre nesta ferramenta" })).toBeNull()
    fireEvent.keyDown(screen.getByRole("article", { name: "Aprovação de ferramenta" }), { key: "Escape" })
    expect(api.calls).toHaveLength(0)
    expect(screen.getByRole("button", { name: "Aprovar" })).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Negar" }))
    await screen.findByText("Negado por você")
    await waitFor(() =>
      expect(api.calls).toContainEqual({
        route: "POST /approvals/:id",
        input: { decision: "denied", standing: false },
        pathValues: { id: "setup-approval" },
      }),
    )
  })
}

it("folder upgrades show the old and requested permissions", () => {
  render(
    <ApprovalCard
      api={createMockApi()}
      part={approval("folder_access_request", {
        path: "/workspace/Documents",
        mode: "read-write",
        previousMode: "read-only",
      })}
    />,
  )
  expect(
    screen.getByText(
      "Permitir Leitura e escrita em /workspace/Documents para este bot. Acesso anterior: Somente leitura.",
    ),
  ).toBeInTheDocument()
})

it("a missing subfolder reviews one write approval on the ancestor and explains automatic creation", () => {
  const tool: ToolCallPart = {
    type: "tool_call",
    callId: "missing-folder",
    tool: "mcp__touri__folder_access_request",
    summary: "folder_access_request",
    inputJson: JSON.stringify({ path: "/fixtures/output/images", mode: "read-write" }),
    outputJson: null,
    ok: null,
  }
  const card = approval("folder_access_request", {
    path: "/fixtures/output",
    requestedPath: "/fixtures/output/images",
    createPath: "/fixtures/output/images",
    mode: "read-write",
    previousMode: "read-only",
    writeApproval: true,
  })
  const view = render(<ToolCallList parts={[tool, card]} api={createMockApi()} createdAt={0} />)
  expect(view.container.querySelectorAll(".tool-call-card")).toHaveLength(1)
  expect(screen.getByText("Permitir escrita em /fixtures/output?")).toBeVisible()
  expect(screen.getByText(/Após aprovar, a pasta \/fixtures\/output\/images será criada automaticamente/)).toBeVisible()
  expect(t("Permitir escrita em {path}?", { path: "/fixtures/output" }, "en")).toBe(
    "Allow writing in /fixtures/output?",
  )
})

it("an external MCP tool with the same name keeps its own presentation", () => {
  render(
    <ApprovalCard
      api={createMockApi()}
      part={{
        ...approval("project_link", { path: "/external", name: "Other" }),
        scope: { source: "mcp", server: "external", tool: "project_link" },
      }}
    />,
  )
  expect(screen.getByText("external · project_link")).toBeInTheDocument()
  expect(screen.queryByText("Vincular projeto")).toBeNull()
})

for (const tool of ["project_link", "folder_access_request"]) {
  for (const requestedPath of ["/workspace/Documents", "~/Documents", "/workspace/alias"]) {
    for (const decision of ["pending", "approved"] as const) {
      it(`${tool} ${decision} attaches one reviewed card for ${requestedPath}`, async () => {
        const user = userEvent.setup()
        const path = "/workspace/Documents"
        const input = { path: requestedPath, ...(tool === "folder_access_request" ? { mode: "read-write" } : {}) }
        const call: ToolCallPart = {
          type: "tool_call",
          callId: "setup-call",
          tool: `mcp__touri__${tool}`,
          summary: tool,
          inputJson: JSON.stringify(input),
          outputJson: null,
          ok: decision === "approved" ? true : null,
        }
        const card = {
          ...approval(tool, {
            ...input,
            path,
            requestedPath,
            name: "Documents",
            previousMode: "read-only",
            nextTurn: true,
          }),
          decision,
        }
        const view = render(
          <ToolCallList parts={[call, card]} api={createMockApi()} finished={decision === "approved"} createdAt={0} />,
        )
        if (decision === "approved") await user.click(screen.getByText("1 ferramenta"))
        const article = screen.getByRole("article", { name: "Aprovação de ferramenta" })
        expect(article).toHaveAttribute("data-call-id", "setup-call")
        expect(view.container.querySelectorAll(".tool-call-card")).toHaveLength(1)
        expect(article.querySelector(".tool-summary")).toHaveTextContent(path)
        expect(article.querySelector(".tool-summary")).toHaveTextContent("próxima mensagem na VM")
        expect(screen.queryByText("2 ferramentas")).toBeNull()
        if (tool === "folder_access_request") {
          expect(article.querySelector(".tool-summary")).toHaveTextContent("Acesso anterior: Somente leitura.")
        }
        if (requestedPath !== path) expect(article.querySelector(".tool-summary")).not.toHaveTextContent(requestedPath)
      })
    }
  }
}

it("matches legacy enriched folder cards but keeps the path, mode, project ID and MCP server boundaries", () => {
  const call = (tool: string, input: unknown): ToolCallPart => ({
    type: "tool_call",
    callId: "setup-call",
    tool: `mcp__touri__${tool}`,
    summary: tool,
    inputJson: JSON.stringify(input),
    outputJson: null,
    ok: null,
  })
  const folder = approval("folder_access_request", {
    path: "/canonical",
    mode: "read",
    previousMode: null,
    nextTurn: false,
  })
  expect(approvalMatchesTool(folder, call("folder_access_request", { path: "/canonical", mode: "read" }))).toBe(true)
  expect(approvalMatchesTool(folder, call("folder_access_request", { path: "/other", mode: "read" }))).toBe(false)
  expect(approvalMatchesTool(folder, call("folder_access_request", { path: "/canonical", mode: "read-write" }))).toBe(
    false,
  )
  const project = approval("project_link", { path: "/canonical", requestedPath: "~/repo", projectId: "project-a" })
  expect(approvalMatchesTool(project, call("project_link", { projectId: "project-a" }))).toBe(true)
  expect(approvalMatchesTool(project, call("project_link", { projectId: "project-b" }))).toBe(false)
  expect(approvalMatchesTool(project, call("project_link", { path: "/canonical" }))).toBe(false)
  for (const tool of ["project_link", "folder_access_request"]) {
    const input = { path: "~/repo", mode: "read" }
    const card = approval(tool, { ...input, path: "/canonical", requestedPath: "~/repo" })
    expect(approvalMatchesTool(card, { ...call(tool, input), tool: `mcp__external__${tool}` })).toBe(false)
    expect(
      approvalMatchesTool({ ...card, scope: { source: "mcp", server: "external", tool } }, call(tool, input)),
    ).toBe(false)
  }
})

it("keeps setup notices, errors and both merged UI features in Portuguese and English", () => {
  const legacyDiscovery =
    "List registered projects and Git repositories discovered on this Mac. Read-only; no approval required. Use this before asking the user for a project path."
  expect(t(legacyDiscovery, {}, "pt-BR")).toBe(
    "Listar projetos registrados e repositórios Git encontrados neste Mac. Somente leitura, sem aprovação. Use antes de pedir o caminho de um projeto.",
  )
  expect(t(legacyDiscovery, {}, "en")).toBe(legacyDiscovery)
  const translations = [
    ["Informe o caminho absoluto de uma pasta deste Mac.", "Enter the absolute path of a folder on this Mac."],
    ["O caminho precisa ser uma pasta.", "The path must be a folder."],
    [
      "O acesso a qualquer pasta deste Mac é exclusivo dos ajustes.",
      "Access to any folder on this Mac can only be enabled in settings.",
    ],
    ["A configuração do bot está indisponível.", "Bot configuration is unavailable."],
    [
      "Somente o próprio bot, sem delegação, pode alterar sua configuração.",
      "Only this bot, without delegation, can change its configuration.",
    ],
    ["Somente o próprio bot pode alterar sua configuração.", "Only this bot can change its configuration."],
    ["Projeto não encontrado.", "Project not found."],
    ["O vínculo não foi aprovado ou a configuração mudou.", "The link was not approved or the configuration changed."],
    ["Pastas deste Mac não estão disponíveis na nuvem.", "Folders on this Mac are unavailable in the cloud."],
    ["O acesso não foi aprovado ou a configuração mudou.", "Access was not approved or the configuration changed."],
    ["Pasta não encontrada nas permissões deste bot.", "Folder not found in this bot’s permissions."],
    [
      "A configuração foi salva neste Mac. Vale a partir da próxima mensagem.",
      "The configuration was saved on this Mac. Takes effect from the next message.",
    ],
    ["Projeto {name} ({path}) vinculado a este bot.", "Project {name} ({path}) linked to this bot."],
    ["Projeto {name} desvinculado deste bot.", "Project {name} unlinked from this bot."],
    ["Acesso {mode} à pasta {path} concedido a este bot.", "This bot was granted {mode} access to folder {path}."],
    ["de leitura", "read"],
    ["de leitura e escrita", "read and write"],
    ["Acesso à pasta {path} removido deste bot.", "This bot’s access to folder {path} was removed."],
    ["atual", "current"],
    ["Pasta permitida (caminho absoluto)", "Allowed folder (absolute path)"],
    ["Ações das configurações do bot", "Bot settings actions"],
    [
      "Somente o próprio bot, sem delegação, pode consultar suas pastas.",
      "Only this bot, without delegation, can list its folders.",
    ],
    [
      "A configuração mudou durante a busca. Tente novamente.",
      "The configuration changed during the search. Try again.",
    ],
    [
      "Projetos e repositórios nas pastas já permitidas a este bot.",
      "Projects and repositories in folders already granted to this bot.",
    ],
  ] as const
  for (const [key, english] of translations) {
    expect(t(key, {}, "pt-BR")).toBe(key)
    expect(t(key, {}, "en")).toBe(english)
  }
})

it("a maximum-length routine prompt shows the reviewed schedule, bounded preview and named activation", async () => {
  const api = createMockApi()
  const prompt = "a".repeat(8000)
  render(
    <ApprovalCard
      api={api}
      tool={{
        type: "tool_call",
        callId: "routine-call",
        tool: "mcp__touri__routine_create",
        inputJson: JSON.stringify({ name: "Provider alias", prompt }),
        summary: "routine_create",
        outputJson: null,
        ok: null,
      }}
      part={approval("routine_create", {
        routineId: "routine-daily",
        name: "Resumo diário QA",
        cron: "0 9 * * *",
        schedule: "Todo dia às 09:00 · horário de São Paulo",
        timezone: "America/Sao_Paulo",
        promptPreview: `${prompt.slice(0, 512)}…`,
        promptLength: prompt.length,
      })}
    />,
  )
  expect(screen.getByText("Ativar rotina")).toBeVisible()
  expect(screen.getByText("Resumo diário QA · Todo dia às 09:00 · horário de São Paulo")).toBeVisible()
  const preview = screen.getByRole("figure", { name: "Parâmetros" })
  expect(preview).toHaveTextContent(`${prompt.slice(0, 512)}…`)
  expect(preview).toHaveTextContent("Tamanho completo: 8000 caracteres")
  expect(preview).not.toHaveTextContent(prompt)
  fireEvent.click(screen.getByRole("button", { name: "Ativar rotina “Resumo diário QA”" }))
  await screen.findByText("Aprovado por você")
  expect(api.calls).toContainEqual({
    route: "POST /approvals/:id",
    input: { decision: "approved", standing: false },
    pathValues: { id: "setup-approval" },
  })
})

it.each([
  'routine_create: {"routineId":"daily","prompt":"cut',
  "routine_create: null",
  "routine_create: []",
  'routine_create: {"routineId":"daily","name":"Resumo"}',
])("unreadable routine review cannot be approved: %s", async (detail) => {
  const api = createMockApi()
  render(
    <ApprovalCard
      api={api}
      tool={{
        type: "tool_call",
        callId: "routine-call",
        tool: "mcp__touri__routine_create",
        inputJson: '{"name":"Provider fallback","cron":"0 9 * * *","timezone":"UTC"}',
        summary: "routine_create",
        outputJson: null,
        ok: null,
      }}
      part={{ ...approval("routine_create", {}), detail, allowStanding: true }}
    />,
  )
  expect(screen.getByText("Detalhes indisponíveis")).toBeVisible()
  expect(
    screen.getByText("Não foi possível mostrar os detalhes desta ação. Negue e peça ao bot para solicitar novamente."),
  ).toBeVisible()
  for (const name of ["Aprovar", "Permitir sempre nesta ferramenta"]) {
    const button = screen.getByRole("button", { name, exact: true })
    expect(button).toBeDisabled()
    fireEvent.click(button)
  }
  expect(api.calls).toEqual([])
  fireEvent.click(screen.getByRole("button", { name: "Negar", exact: true }))
  await screen.findByText("Negado por você")
  expect(api.calls).toContainEqual({
    route: "POST /approvals/:id",
    input: { decision: "denied", standing: false },
    pathValues: { id: "setup-approval" },
  })
})
