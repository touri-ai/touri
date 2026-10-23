import { createMockApi } from "../../src/api/mock"

export const getRoutineChannelFixture = async () => {
  const api = createMockApi()
  const [bot, otherBot] = api.getState().bots
  const { routines } = await api.request("GET /routines", {})
  const existing = routines[0]
  if (!bot || !otherBot || !existing) throw new Error("Missing synthetic routine fixture")

  const { group, thread } = await api.request("POST /groups", { name: "Relatórios", memberIds: [bot.id] })
  const { group: eligibleGroup } = await api.request("POST /groups", {
    name: "Planejamento",
    memberIds: [bot.id],
  })
  const { group: otherGroup } = await api.request("POST /groups", {
    name: "Pesquisa",
    memberIds: [otherBot.id],
  })
  const { routine } = await api.request(
    "PATCH /routines/:id",
    {
      name: "Resumo do canal",
      prompt: "Resuma as tarefas fictícias do canal.",
      groupId: group.id,
      continuity: "results-thread",
      resultsThreadId: thread.id,
    },
    { id: existing.id },
  )

  return { api, bot, otherBot, group, eligibleGroup, otherGroup, thread, routine }
}
