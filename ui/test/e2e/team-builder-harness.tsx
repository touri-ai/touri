import type { ApprovalPart, BotGroup, Message, ToolCallPart } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { createMockApi } from "../../src/api/mock"
import { getTeamReview } from "../fixtures/team-proposal"
import "../../src/styles.css"

const isPartial = new URLSearchParams(window.location.search).get("scenario") === "partial"
const api = createMockApi()
const state = api.getState()
const createdGroups: BotGroup[] = []
const builder = state.bots[0]
const thread = state.threads.find((item) => item.botId === builder?.id)
const template = state.messages[0]
if (!builder || !thread || !template) throw new Error("Missing synthetic fixture")
builder.name = "Criador de times"
builder.roleLine = "Conversa sobre o trabalho e propõe seu time."
builder.teamBuilder = true
builder.projectId = null
builder.homeDir = "/workspace/builder"
state.bots.splice(0, state.bots.length, builder)
state.threads.splice(0, state.threads.length, thread)
thread.title = "Meu time de conteúdo"
const review = getTeamReview()
const tool: ToolCallPart = {
  type: "tool_call",
  callId: "team-call",
  tool: "mcp__touri__team_create",
  summary: "team_create",
  inputJson: JSON.stringify(review.proposal),
  outputJson: null,
  ok: null,
}
const approval: ApprovalPart = {
  type: "approval",
  approvalId: "team",
  botId: builder.id,
  request: "permission",
  detail: 'team_create: {"botCount":3,"groupName":"Conteúdo semanal"}',
  decision: "pending",
  allowStanding: false,
  scope: { source: "mcp", server: "touri", tool: "team_create" },
  teamProposal: review,
}
const user: Message = {
  ...template,
  id: "team-request",
  threadId: thread.id,
  parentId: null,
  role: "user",
  text: "Quero um time para pesquisar, escrever e revisar meus posts semanais.",
  parts: [],
  runId: null,
  status: "complete",
}
const reply: Message = {
  ...template,
  id: "team-reply",
  threadId: thread.id,
  parentId: user.id,
  role: "assistant",
  text: "Preparei três funções complementares. Confira os bots e o grupo antes de criar.",
  parts: [tool, approval],
  runId: null,
  status: "streaming",
}
state.messages.splice(0, state.messages.length, user, reply)
thread.activeLeafId = reply.id
const request = api.request
api.request = (async (route, args, params) => {
  const result = await request(route, args, params)
  if (route !== "POST /approvals/:id" || params?.id !== "team") return result
  const approved = (args as { decision: string }).decision === "approved"
  if (approved) {
    const bots = await Promise.all(
      review.proposal.bots
        .filter((_, index) => !isPartial || index === 0)
        .map(
          async (draft) =>
            (
              await request("POST /bots", {
                ...draft,
                access: "workspace-write",
                approvals: "on-request",
                machine: "local",
                projectId: null,
                cwd: null,
                folders: [],
                anyFolderAccess: false,
                browserEnabled: false,
                computerUse: false,
                hostComputerUse: false,
              })
            ).bot,
        ),
    )
    const createdGroup = isPartial
      ? null
      : await request("POST /groups", {
          name: "Conteúdo semanal",
          memberIds: bots.map((bot) => bot.id),
          coordinatorBotId: bots[1]?.id ?? null,
          avatarShape: "cercle",
          color: "#5C7CFA",
        })
    // Fixture state mirrors API events so the real app can render the result.
    if (createdGroup) createdGroups.push(createdGroup.group)
    approval.teamResult = {
      status: isPartial ? "partial" : "created",
      bots: bots.map((bot) => ({ id: bot.id, name: bot.name, threadId: bot.mainThreadId })),
      ...(createdGroup
        ? { group: { id: createdGroup.group.id, name: createdGroup.group.name, threadId: createdGroup.thread.id } }
        : { error: "creation-failed" as const }),
    }
  }
  approval.decision = approved ? "approved" : "denied"
  reply.parts = [tool, { ...approval }]
  reply.status = "complete"
  api.emit({ type: "message.updated", message: { ...reply } })
  return result
}) as typeof api.request
Object.assign(window, {
  teamQa: {
    state: () => ({ bots: api.getState().bots, groups: createdGroups }),
    calls: api.calls,
  },
})
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
