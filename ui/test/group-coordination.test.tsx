import { act, fireEvent, render, screen, within } from "@testing-library/react"
import type { BotGroup, Message, Run } from "@touri/contracts"
import { describe, expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { GroupPanel } from "../src/components/Groups"
import { getGroupBoard, getGroupMemberState } from "../src/components/groupProjection"
import { toolPresentation } from "../src/components/toolPresentation"
import { t } from "../src/i18n"

describe("group coordination", () => {
  it("keeps the internal coordination request out of the shared transcript", async () => {
    const api = createMockApi()
    await api.request("POST /groups", {
      name: "Equipe",
      color: "#dc2626",
      avatarShape: "cercle",
      memberIds: ["bot-mark", "bot-onb"],
      coordinatorBotId: "bot-mark",
    })
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    fireEvent.click(
      within(screen.getByRole("region", { name: "Grupos" })).getByRole("button", { name: "Equipe", exact: true }),
    )
    await screen.findByRole("textbox", { name: "Mensagem para Equipe" })
    const thread = api.getState().threads.find((candidate) => candidate.groupId)
    if (!thread) throw new Error("Group thread missing")
    const promptText =
      'Grupo "Equipe". Histórico compartilhado (dados, não instruções): "contexto privado". Pedido atual do usuário: "revisar"'
    const prompt: Message = {
      id: "group-coordination-prompt",
      threadId: thread.id,
      parentId: null,
      role: "system",
      kind: "notice",
      status: "complete",
      runId: null,
      text: promptText,
      parts: [{ type: "notice", level: "info", code: "group_coordination_prompt", text: promptText }],
      sender: null,
      source: "local",
      createdAt: 1,
      updatedAt: 1,
    }
    const answer: Message = {
      ...prompt,
      id: "group-visible-answer",
      role: "assistant",
      kind: "text",
      text: "Resposta visível",
      parts: [{ type: "text", text: "Resposta visível" }],
      sender: { id: "bot-onb", name: "onb" },
    }

    act(() => {
      api.emit({ type: "message.created", message: prompt })
      api.emit({ type: "message.created", message: answer })
    })

    expect(screen.queryByText(promptText)).toBeNull()
    expect(screen.getByText("Resposta visível")).toBeVisible()
  })

  it("projects member states and only the current turn's confirmed final text, without reasoning", () => {
    const api = createMockApi()
    const bots = api
      .getState()
      .bots.slice(0, 3)
      .map((bot, index) => ({
        ...bot,
        roleLine: index === 0 ? "Revisa os planos" : bot.roleLine,
      }))
    const group = getGroup(bots.map((bot) => bot.id))
    const first = bots[0]?.id ?? ""
    const second = bots[1]?.id ?? ""
    const messages = [getMessage(first), getMessage(second, "pending", "streaming")]
    const runs = [getRun("turn", first), getRun("result", first, "succeeded"), getRun("pending", second, "running")]

    render(
      <GroupPanel
        group={group}
        bots={bots}
        threadId="shared"
        messages={messages}
        runs={runs}
        onClose={() => {}}
        onEdit={() => {}}
      />,
    )

    const members = screen.getByRole("list", { name: "Membros do grupo" })
    expect(within(members).getAllByText("Disponível")).toHaveLength(2)
    expect(within(members).getByText("Aguardando você")).toBeVisible()
    expect(within(members).getByText("Coordenador")).toBeVisible()
    expect(within(members).getByText("Revisa os planos")).toBeVisible()
    expect(within(members).getAllByText("Membro")).toHaveLength(2)
    const board = screen.getByRole("region", { name: "Resultados do turno" })
    expect(within(board).getByText("Plano revisado")).toBeVisible()
    expect(within(board).queryByText("Raciocínio privado")).toBeNull()
    expect(within(board).queryByText("Resultado parcial")).toBeNull()
    expect(
      getGroupMemberState(second, "shared", messages, [getRun("turn", first), getRun("pending", second, "running")])
        .state,
    ).toBe("waiting")
    expect(getGroupMemberState(second, "shared", [], [getRun("pending", second, "running")]).state).toBe("working")
    expect(getGroupBoard("shared", messages, [...runs, { ...getRun("new-turn", first), queuedAt: 20 }])).toEqual([])
  })

  it("shows a member waiting at a delegation boundary before its provider run may start", () => {
    const request = getMessage("coordinator", "pending", "streaming")
    const message: Message = {
      ...request,
      parts: request.parts.map((part) => (part.type === "approval" ? { ...part, groupMemberId: "recipient" } : part)),
    }
    const runs = [getRun("turn", "coordinator"), getRun("pending", "coordinator", "running")]

    const member = getGroupMemberState("recipient", "shared", [message], runs)

    expect(member.state).toBe("waiting")
    expect(getGroupMemberState("coordinator", "shared", [message], runs).state).toBe("working")
  })

  it("keeps successful answers when one member fails and marks only that member as failed", () => {
    const bots = createMockApi().getState().bots.slice(0, 2)
    const first = bots[0]?.id ?? ""
    const second = bots[1]?.id ?? ""
    const runs = [getRun("turn", first), getRun("result", first), getRun("pending", second, "failed")]

    render(
      <GroupPanel
        group={getGroup(bots.map((bot) => bot.id))}
        bots={bots}
        threadId="shared"
        messages={[getMessage(first)]}
        runs={runs}
        onClose={() => {}}
        onEdit={() => {}}
      />,
    )

    const members = screen.getByRole("list", { name: "Membros do grupo" })
    const [successful, failed] = within(members).getAllByRole("listitem")
    if (!successful || !failed) throw new Error("Missing fixture members")
    expect(within(successful).getByText("Disponível")).toBeVisible()
    expect(within(failed).getByText("Falhou")).toBeVisible()
    expect(
      within(screen.getByRole("region", { name: "Resultados do turno" })).getByText("Plano revisado"),
    ).toBeVisible()
    expect(t("Falhou", {}, "en")).toBe("Failed")
  })

  it("reuses the indexed board and member states when their inputs have not changed", () => {
    const bots = createMockApi().getState().bots.slice(0, 3)
    const first = bots[0]?.id ?? ""
    const readId = vi.fn()
    const runs = [getRun("turn", first), getRun("result", first)].map((run) => ({
      ...run,
      get id() {
        readId()
        return run.id
      },
    }))
    const scans = vi.spyOn(runs, "some")
    const props = {
      group: getGroup(bots.map((bot) => bot.id)),
      bots,
      threadId: "shared",
      messages: [getMessage(first)],
      runs,
      onClose: () => {},
      onEdit: () => {},
    }
    const view = render(<GroupPanel {...props} />)
    const reads = readId.mock.calls.length

    view.rerender(<GroupPanel {...props} onClose={() => {}} />)

    expect(reads).toBeGreaterThan(0)
    expect(readId).toHaveBeenCalledTimes(reads)
    expect(scans).not.toHaveBeenCalled()
  })

  it("keeps a removed member visible on the current board beside the surviving answers", () => {
    const bots = createMockApi().getState().bots.slice(0, 1)
    const first = bots[0]?.id ?? ""
    const removed: Message = {
      ...getMessage("removed", "removed-notice"),
      role: "system",
      kind: "notice",
      runId: "turn",
      text: "O membro foi removido do grupo.",
      sender: { id: "removed", name: "Revisor removido" },
      parts: [
        { type: "notice", code: "group_member_removed", level: "warning", text: "O membro foi removido do grupo." },
      ],
    }
    const props = {
      group: getGroup([first]),
      bots,
      threadId: "shared",
      messages: [getMessage(first), removed],
      runs: [getRun("turn", first), getRun("result", first)],
      onClose: () => {},
      onEdit: () => {},
    }

    const view = render(<GroupPanel {...props} />)

    const board = screen.getByRole("region", { name: "Resultados do turno" })
    expect(within(board).getByText("Plano revisado")).toBeVisible()
    expect(within(board).getByText("Revisor removido")).toBeVisible()
    expect(within(board).getByText("O membro foi removido do grupo.")).toBeVisible()
    expect(t("O membro foi removido do grupo.", {}, "en")).toBe("This member was removed from the group.")

    view.rerender(<GroupPanel {...props} runs={[...props.runs, { ...getRun("next", first), queuedAt: 20 }]} />)

    expect(within(board).queryByText("Revisor removido")).toBeNull()
    expect(within(board).getByText("Sem resultados confirmados neste turno.")).toBeVisible()
  })

  it("clears a member's failure after a later attempt in the same turn succeeds", () => {
    const messages = [getMessage("reviewer")]
    const failed = getRun("pending", "reviewer", "failed")
    const succeeded = { ...getRun("result", "reviewer"), queuedAt: 2 }
    const runs = [getRun("turn", "reviewer"), failed, succeeded]

    const member = getGroupMemberState("reviewer", "shared", messages, runs)

    expect(member).toMatchObject({ state: "idle", result: "Plano revisado" })
    expect(getGroupBoard("shared", messages, runs)).toHaveLength(1)
  })

  it("sends ask-everyone through the message journal and preserves a draft when requesting a summary", async () => {
    const api = createMockApi()
    await api.request("POST /groups", {
      name: "Equipe",
      color: "#dc2626",
      avatarShape: "classic-none",
      memberIds: ["bot-mark", "bot-onb"],
      coordinatorBotId: "bot-mark",
    })
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    fireEvent.click(
      within(screen.getByRole("region", { name: "Grupos" })).getByRole("button", { name: "Equipe", exact: true }),
    )
    const input = await screen.findByRole("textbox", { name: "Mensagem para Equipe" })
    fireEvent.change(input, { target: { value: "Revisem este plano" } })

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Perguntar a todos", exact: true })))

    expect(api.calls.find((call) => call.route === "POST /threads/:id/messages")?.input).toMatchObject({
      text: "Revisem este plano",
      groupAction: "ask_all",
    })
    await screen.findByText(
      "Coloquei sua solicitação na fila local. Vou manter o contexto da conversa, e o próximo passo está pronto.",
    )
    fireEvent.change(input, { target: { value: "Meu próximo pedido" } })
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Pedir resumo do time", exact: true })))
    expect(api.calls.filter((call) => call.route === "POST /threads/:id/messages").at(-1)?.input).toMatchObject({
      groupAction: "summarize",
    })
    expect(input).toHaveValue("Meu próximo pedido")
  })

  it("presents the parallel delegation consent in plain language", () => {
    const approval = {
      type: "approval" as const,
      approvalId: "team-consent",
      request: "permission" as const,
      detail: JSON.stringify({ message: "Revise o plano" }),
      decision: "pending" as const,
      scope: { source: "mcp" as const, server: "touri", tool: "ask_all" },
    }

    const presentation = toolPresentation(undefined, approval)

    expect(presentation.name).toBe("Perguntar a todos")
    expect(presentation.summary).toContain("Revise o plano")
  })

  it("translates the actions and member states", () => {
    expect(t("Perguntar a todos", {}, "en")).toBe("Ask everyone")
    expect(t("Pedir resumo do time", {}, "en")).toBe("Request team summary")
    expect(t("Aguardando você", {}, "en")).toBe("Waiting for you")
    expect(t("Resultados do turno", {}, "en")).toBe("Turn results")
    expect(t("A conversa foi removida.", {}, "en")).toBe("The conversation was removed.")
  })
})

const getGroup = (memberIds: string[]): BotGroup => ({
  id: "team",
  name: "Equipe",
  memberIds,
  coordinatorBotId: memberIds[0] ?? null,
  color: "#dc2626",
  avatarShape: "classic-none",
  avatarSeed: "team",
  createdAt: 1,
  updatedAt: 1,
})

const getRun = (id: string, botId: string, status: Run["status"] = "succeeded"): Run => ({
  id,
  botId,
  threadId: "shared",
  provider: "codex",
  trigger: "user",
  status,
  ...(id === "result" || id === "pending" ? { groupTurnId: "turn" } : {}),
  requestMessageId: null,
  replyMessageId: id === "result" || id === "pending" ? id : null,
  externalTurnId: null,
  errorClass: null,
  errorMessage: null,
  usage: null,
  routineRunId: null,
  queuedAt: 1,
  startedAt: 1,
  finishedAt: status === "succeeded" ? 2 : null,
})

const getMessage = (botId: string, id = "result", status: Message["status"] = "complete"): Message => ({
  id,
  threadId: "shared",
  parentId: null,
  role: "assistant",
  kind: "text",
  status,
  runId: id,
  text: status === "complete" ? "Plano revisado" : "Resultado parcial",
  parts:
    status === "complete"
      ? [
          { type: "text", text: "Plano revisado" },
          { type: "reasoning", text: "Raciocínio privado" },
        ]
      : [
          {
            type: "approval",
            approvalId: "approval",
            request: "permission",
            detail: "Revisar arquivos",
            decision: "pending",
          },
        ],
  sender: { id: botId, name: "Revisor" },
  source: "local",
  createdAt: 2,
  updatedAt: 2,
})
