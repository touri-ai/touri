import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ApprovalPart, ToolCallPart } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { ApprovalCard } from "../src/components/ApprovalCard"
import { BotCreateModal } from "../src/components/Modals"
import { TeamApprovalCard } from "../src/components/TeamApprovalCard"
import { ToolCallList } from "../src/components/ToolCallList"
import { approvalMatchesTool } from "../src/components/toolPresentation"
import { ApiError } from "../src/errors"
import { getJobTemplates } from "../src/features/jobs/catalog"
import { getTeamReview } from "./fixtures/team-proposal"

afterEach(cleanup)
const getApproval = (): ApprovalPart => ({
  type: "approval",
  approvalId: "team",
  botId: "builder",
  request: "permission",
  detail: 'team_create: {"botCount":3,"groupName":"Conteúdo semanal"}',
  scope: { source: "mcp", server: "touri", tool: "team_create" },
  decision: "pending",
  allowStanding: false,
  teamProposal: getTeamReview(),
})
const getTool = (): ToolCallPart => ({
  type: "tool_call",
  tool: "mcp__touri__team_create",
  callId: "team-call",
  inputJson: JSON.stringify(getTeamReview().proposal),
  outputJson: null,
  ok: null,
  summary: "team_create",
})

it("shows the complete reviewed team, providers, access and group with explicit consent only", async () => {
  const api = createMockApi()
  render(
    <ToolCallList
      parts={[getTool(), { ...getApproval(), allowStanding: true }]}
      api={api}
      finished={false}
      createdAt={1}
    />,
  )

  expect(screen.getAllByText("Proposta de time")).toHaveLength(1)
  for (const name of ["Pesquisa", "Escrita", "Revisão"]) expect(screen.getByText(name, { exact: true })).toBeVisible()
  expect(screen.getByText("Instalação ou login pendente")).toBeVisible()
  expect(screen.getByText("Pede permissão antes de mudar arquivos")).toBeVisible()
  expect(screen.getByText("Máquina local · sem projeto ou pastas extras")).toBeVisible()
  expect(screen.getByText("Navegador e controle do computador desativados")).toBeVisible()
  expect(screen.getByText(getTeamReview().proposal.bots[0]?.instructions ?? "")).toBeVisible()
  expect(screen.getByText("Grupo: Conteúdo semanal")).toBeVisible()
  expect(screen.getByText("Coordenador: Escrita")).toBeVisible()
  expect(screen.queryByRole("button", { name: "Permitir sempre nesta ferramenta" })).toBeNull()
  const approve = screen.getByRole("button", { name: "Criar time" })
  fireEvent.keyDown(approve, { key: "Enter" })
  fireEvent.keyDown(approve, { key: " " })
  expect(api.calls).toHaveLength(0)

  fireEvent.click(approve)
  await screen.findByText("Criando time…")

  expect(api.calls).toEqual([
    { route: "POST /approvals/:id", input: { decision: "approved", standing: false }, pathValues: { id: "team" } },
  ])
})

it.each([
  ["pt-BR", "Usa a chave de API salva"],
  ["en", "Uses your saved API key"],
] as const)("flags API models using the saved key in %s", (locale, label) => {
  const review = getTeamReview()
  const teamProposal = {
    ...review,
    proposal: {
      ...review.proposal,
      bots: review.proposal.bots.map((bot, index) => (index === 2 ? { ...bot, model: "touri-api-modelo-demo" } : bot)),
    },
  }

  render(<TeamApprovalCard part={{ ...getApproval(), teamProposal }} api={createMockApi()} locale={locale} />)

  expect(screen.getByText(label)).toBeVisible()
})

it("does not approve a proposal with hidden characters in a model identifier", () => {
  const review = getTeamReview()
  const teamProposal = {
    ...review,
    proposal: {
      ...review.proposal,
      bots: review.proposal.bots.map((bot, index) =>
        index === 2 ? { ...bot, model: "touri-api-modelo-demo\u200b" } : bot,
      ),
    },
  }

  render(<TeamApprovalCard part={{ ...getApproval(), teamProposal }} api={createMockApi()} />)

  expect(screen.getByRole("button", { name: "Criar time" })).toBeDisabled()
})

it.each(["click", "escape"])("cancels with %s and says nothing was created", async (action) => {
  const api = createMockApi()
  render(<ApprovalCard part={getApproval()} api={api} />)

  if (action === "click") fireEvent.click(screen.getByRole("button", { name: "Cancelar" }))
  else fireEvent.keyDown(screen.getByRole("article"), { key: "Escape" })
  await screen.findByText("Time cancelado")

  expect(screen.getByText("Nenhum bot ou grupo foi criado.")).toBeVisible()
  expect(api.calls[0]?.input).toEqual({ decision: "denied", standing: false })
})

it("retains completed team cards and navigation links when the turn finishes", () => {
  const part: ApprovalPart = {
    ...getApproval(),
    decision: "approved",
    teamResult: {
      status: "created",
      bots: [{ id: "research", name: "Pesquisa", threadId: "research-chat" }],
      group: { id: "content", name: "Conteúdo semanal", threadId: "group-chat" },
    },
  }
  render(<ToolCallList parts={[getTool(), part]} api={createMockApi()} finished createdAt={1} />)
  expect(screen.getByText("Time criado")).toBeVisible()
  expect(screen.getByRole("link", { name: "Pesquisa" })).toHaveAttribute("href", "?bot=research&thread=research-chat")
  const navigation = vi.fn()
  window.addEventListener("touri:open-conversation", navigation, { once: true })

  fireEvent.click(screen.getByRole("link", { name: /Abrir conversa do grupo/ }))

  expect(navigation.mock.calls[0]?.[0].detail).toEqual({ bot: null, thread: "group-chat" })
})

it("partial failure offers one-click deletion for committed bots and explains the missing group", async () => {
  const api = createMockApi()
  render(
    <ApprovalCard
      api={api}
      part={{
        ...getApproval(),
        decision: "approved",
        teamResult: {
          status: "partial",
          bots: [{ id: "bot-mark", name: "mark", threadId: "thread-mark" }],
          error: "creation-failed",
        },
      }}
    />,
  )
  expect(screen.getByRole("alert")).toHaveTextContent("o grupo não foi criado")
  expect(screen.getAllByRole("link")).toHaveLength(1)
  expect(screen.queryByRole("link", { name: /Abrir conversa/ })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Apagar bots criados" }))

  await screen.findByText("Bots criados apagados.")

  expect(api.calls.filter((call) => call.route === "DELETE /bots/:id")).toEqual([
    { route: "DELETE /bots/:id", input: { name: "mark" }, pathValues: { id: "bot-mark" } },
  ])
  expect(screen.queryByRole("link", { name: "mark" })).toBeNull()
})

it.each([
  undefined,
  { proposal: { bots: [] }, providers: [] },
  { ...getTeamReview(), proposal: { bots: [{ ...getTeamReview().proposal.bots[0], access: "full" }] } },
])("malformed or broader-access review cannot be approved", (teamProposal) => {
  const part = { ...getApproval(), teamProposal } as ApprovalPart
  render(<ApprovalCard part={part} api={createMockApi()} />)
  expect(screen.getByText("Detalhes indisponíveis")).toBeVisible()
  expect(screen.getByRole("button", { name: "Criar time" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Cancelar" })).toBeEnabled()
})

it("matches only the complete reviewed proposal from the own MCP server", () => {
  expect(approvalMatchesTool(getApproval(), getTool())).toBe(true)
  expect(
    approvalMatchesTool(getApproval(), {
      ...getTool(),
      inputJson: JSON.stringify({ ...getTeamReview().proposal, group: undefined }),
    }),
  ).toBe(false)
  expect(
    approvalMatchesTool(
      { ...getApproval(), scope: { source: "mcp", server: "external", tool: "team_create" } },
      getTool(),
    ),
  ).toBe(false)
})

it("has the opt-in job and full card in English", () => {
  const job = getJobTemplates("en").find((job) => job.id === "team-builder")
  expect(job?.name).toBe("Team builder")
  expect(job?.instructions).toContain("automatic continuations")
  render(<TeamApprovalCard part={getApproval()} api={createMockApi()} locale="en" />)
  expect(screen.getByRole("button", { name: "Create team" })).toBeVisible()
  expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible()
  expect(screen.getByText("Browser and computer control disabled")).toBeVisible()
  expect(screen.getByText("Installation or sign-in needed")).toBeVisible()
  cleanup()
  render(
    <TeamApprovalCard
      part={{
        ...getApproval(),
        decision: "approved",
        teamResult: { status: "partial", bots: [{ id: "bot-mark", name: "mark", threadId: "thread-mark" }] },
      }}
      api={createMockApi()}
      locale="en"
    />,
  )
  expect(screen.getByRole("button", { name: "Delete created bots" })).toBeVisible()
})

it("only explicit selection of the builder job sends the immutable creation choice", async () => {
  const create = vi.fn(async () => undefined)
  render(<BotCreateModal onClose={vi.fn()} onCreate={create} />)
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Meu criador" } })
  fireEvent.click(screen.getByRole("radio", { name: "Criador de times" }))
  fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
  await screen.findByRole("radio", { name: "Criador de times" })
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ jobId: "team-builder" }))
})

it("accepts the same empty default model and nonempty avatar seed as bot creation", () => {
  const part = getApproval()
  const bot = part.teamProposal?.proposal.bots[0]
  if (!bot) throw new Error("Missing draft")
  const review = { ...getTeamReview(), proposal: { bots: [{ ...bot, model: "", avatarSeed: " " }] } }
  render(<ApprovalCard part={{ ...part, teamProposal: review }} api={createMockApi()} />)

  expect(screen.getByRole("button", { name: "Criar time" })).toBeEnabled()
  expect(screen.getByText(/Modelo padrão/)).toBeVisible()
})

it.each(
  [
    "\u200B",
    "\u200D",
    "\u200F",
    "\u2060",
    "\u202E",
    "\u2066",
    "\u2069",
    "\uFEFF",
    "\u{E0061}",
    "\uFE00",
    "\uFE0E",
    "\uFE0F",
    "\u{E0100}",
    "\u{E01EF}",
    "\u034F",
    "\u115F",
    "\u1160",
    "\u3164",
    "\uFFA0",
    "\u0600",
    "\u0000",
    "\u0008",
    "\u001B",
    "\u007F",
    "\u0085",
    "\u009F",
  ]
    .map((character): readonly [string, string] => [
      `U+${character.codePointAt(0)?.toString(16)}`,
      `Visible${character}hidden`,
    ])
    .concat([
      ["repeated selector", "❤️\uFE0F"],
      ["text selector on emoji", "🐂\uFE0E"],
      ["supplementary selector on emoji", "🐂\u{E0100}"],
      ["trailing joiner", "👩\u200Dhidden"],
      ["leading joiner", "hidden\u200D👩"],
      ["repeated joiner", "👩\u200D\u200D🔬"],
      ["misplaced selector", "👩\u200D\uFE0F🔬"],
      ["whitespace inside emoji", "👩\t\u200D🔬"],
    ])
    .flatMap(([label, text]) =>
      ["name", "roleLine", "instructions", "group"].map((field) => [label, field, text] as const),
    ),
)("%s in %s disables team approval", (_, field, text) => {
  const original = getTeamReview()
  const proposal =
    field === "group"
      ? { ...original.proposal, group: { ...original.proposal.group, name: text } }
      : {
          bots: original.proposal.bots.map((bot, index) => (index ? bot : { ...bot, [field]: text })),
        }
  const teamProposal = { ...original, proposal } as ApprovalPart["teamProposal"]

  render(<TeamApprovalCard part={{ ...getApproval(), teamProposal }} api={createMockApi()} />)

  expect(screen.getByRole("button", { name: "Criar time" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Cancelar" })).toBeEnabled()
})

it.each(
  ["\t", "\n", "\r"].flatMap((character) =>
    ["name", "roleLine", "group"].map((field) => [character.codePointAt(0)?.toString(16), field, character] as const),
  ),
)("multiline U+%s in %s disables team approval", (_, field, character) => {
  const original = getTeamReview()
  const text = `Visible${character}text`
  const proposal =
    field === "group"
      ? { ...original.proposal, group: { ...original.proposal.group, name: text } }
      : { bots: original.proposal.bots.map((bot) => ({ ...bot, [field]: text })) }
  const teamProposal = { ...original, proposal } as ApprovalPart["teamProposal"]

  render(<TeamApprovalCard part={{ ...getApproval(), teamProposal }} api={createMockApi()} />)

  expect(screen.getByRole("button", { name: "Criar time" })).toBeDisabled()
})

it.each(["🐂", "❤️", "👩‍🔬", "👩🏽‍💻", "🏳️‍🌈", "👨‍👩‍👧‍👦"])(
  "emoji %s and multiline instructions remain approvable",
  (emoji) => {
    const original = getTeamReview()
    const teamProposal = {
      ...original,
      proposal: {
        bots: original.proposal.bots.map((bot) => ({
          ...bot,
          name: `${bot.name} ${emoji}`,
          roleLine: `${bot.roleLine} ${emoji}`,
          instructions: `${bot.instructions}\r\n\tReview with the user. ${emoji}`,
        })),
        group: { name: `Team ${emoji}`, members: original.proposal.bots.map((bot) => `${bot.name} ${emoji}`) },
      },
    }

    render(<TeamApprovalCard part={{ ...getApproval(), teamProposal }} api={createMockApi()} />)

    expect(screen.getByRole("button", { name: "Criar time" })).toBeEnabled()
    expect(
      screen.getByText(teamProposal.proposal.bots[0]?.instructions ?? "", { normalizer: (text) => text }),
    ).toBeVisible()
  },
)

it("a reloaded partial card treats already deleted bots as cleaned up", async () => {
  const api = createMockApi()
  const part: ApprovalPart = {
    ...getApproval(),
    decision: "approved",
    teamResult: { status: "partial", bots: [{ id: "bot-mark", name: "mark", threadId: "thread-mark" }] },
  }
  render(<TeamApprovalCard part={part} api={api} />)
  fireEvent.click(screen.getByRole("button", { name: "Apagar bots criados" }))
  await screen.findByText("Bots criados apagados.")
  cleanup()

  render(<TeamApprovalCard part={part} api={api} />)
  fireEvent.click(screen.getByRole("button", { name: "Apagar bots criados" }))
  await screen.findByText("Bots criados apagados.")

  expect(screen.queryByRole("button", { name: "Apagar bots criados" })).toBeNull()
  expect(screen.queryByRole("link", { name: "mark" })).toBeNull()
})

it("cleanup retains permission failures for retry", async () => {
  const api = createMockApi()
  const request = api.request
  const denied = { ...api, request: vi.fn(request).mockRejectedValue(new ApiError(403, "Denied", "DENIED")) }
  const part: ApprovalPart = {
    ...getApproval(),
    decision: "approved",
    teamResult: { status: "partial", bots: [{ id: "bot-mark", name: "mark", threadId: "thread-mark" }] },
  }

  render(<TeamApprovalCard part={part} api={denied} />)
  fireEvent.click(screen.getByRole("button", { name: "Apagar bots criados" }))
  await screen.findByText("Não foi possível apagar todos os bots. Tente novamente.")

  expect(screen.getByRole("button", { name: "Apagar bots criados" })).toBeEnabled()
  expect(screen.getByRole("link", { name: "mark" })).toBeVisible()
})
