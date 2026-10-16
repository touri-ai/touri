import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ApprovalPart, ToolCallPart } from "@touri/contracts"
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
        path: "/Users/test/javascript/Hodler",
        name: "Hodler",
        previousProject: { name: "Anterior", path: "/Users/test/Anterior" },
      })}
    />,
  )
  expect(screen.getByText("Vincular projeto")).toBeInTheDocument()
  expect(
    screen.getByText(
      "Vincular Hodler (/Users/test/javascript/Hodler) a este bot Substitui o projeto Anterior (/Users/test/Anterior).",
    ),
  ).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Sempre neste bot" })).toBeNull()
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
  it(`folder approval shows ${label}, the canonical path and VM timing; Escape denies`, async () => {
    const api = createMockApi()
    render(
      <ApprovalCard
        api={api}
        part={approval("folder_access_request", { path: "/Users/test/Documents", mode, nextTurn: true })}
      />,
    )
    expect(screen.getByText("Conceder acesso à pasta")).toBeInTheDocument()
    expect(
      screen.getByText(
        `Permitir ${label} em /Users/test/Documents para este bot A mudança entra em vigor no próximo turno da VM.`,
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Sempre neste bot" })).toBeNull()
    fireEvent.keyDown(screen.getByRole("article", { name: "Aprovação de ferramenta" }), { key: "Escape" })
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
        path: "/Users/test/Documents",
        mode: "read-write",
        previousMode: "read-only",
      })}
    />,
  )
  expect(
    screen.getByText(
      "Permitir Leitura e escrita em /Users/test/Documents para este bot Acesso anterior: Somente leitura.",
    ),
  ).toBeInTheDocument()
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
  for (const requestedPath of ["/Users/test/Documents", "~/Documents", "/Users/test/alias"]) {
    for (const decision of ["pending", "approved"] as const) {
      it(`${tool} ${decision} attaches one reviewed card for ${requestedPath}`, () => {
        const path = "/Users/test/Documents"
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
        const article = screen.getByRole("article", { name: "Aprovação de ferramenta" })
        expect(article).toHaveAttribute("data-call-id", "setup-call")
        expect(view.container.querySelectorAll(".tool-call-card")).toHaveLength(1)
        expect(article.querySelector(".tool-summary")).toHaveTextContent(path)
        expect(article.querySelector(".tool-summary")).toHaveTextContent("próximo turno da VM")
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
      "A configuração foi salva neste Mac e será aplicada no próximo turno local.",
      "The configuration was saved on this Mac and will apply on the next local turn.",
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
