import { describe, expect, it } from "vitest"
import { createMockApi } from "../src/api/mock"
import { getModeSelection, getModeThread } from "../src/workspaceModes"

describe("mode destinations", () => {
  it("restores each mode's last conversation", async () => {
    const api = createMockApi()
    const { group } = await api.request("POST /groups", {
      name: "Viagens",
      color: "#dc2626",
      avatarShape: "classic-none",
      memberIds: ["bot-mark"],
      coordinatorBotId: null,
    })
    const threads = api.getState().threads
    const channel = threads.find((thread) => thread.groupId === group.id)

    const bots = getModeThread("bots", threads, "thread-onb")
    const work = getModeThread("work", threads, channel?.id)

    expect(bots?.id).toBe("thread-onb")
    expect(work?.groupId).toBe(group.id)
  })

  it("never restores a Work channel in Bots mode", async () => {
    const api = createMockApi()
    const { group } = await api.request("POST /groups", {
      name: "Viagens",
      color: "#dc2626",
      avatarShape: "classic-none",
      memberIds: ["bot-mark"],
      coordinatorBotId: null,
    })
    const threads = api.getState().threads
    const channel = threads.find((thread) => thread.groupId === group.id)

    const target = getModeThread("bots", threads, channel?.id)

    expect(target).toBeDefined()
    expect(target?.groupId ?? null).toBeNull()
  })

  it("falls back to a channel when the remembered Work item was deleted", async () => {
    const api = createMockApi()
    const { group } = await api.request("POST /groups", {
      name: "Viagens",
      color: "#dc2626",
      avatarShape: "classic-none",
      memberIds: ["bot-mark"],
      coordinatorBotId: null,
    })

    const target = getModeThread("work", api.getState().threads, "deleted")

    expect(target?.groupId).toBe(group.id)
  })
})

it("restores a bot whose first conversation has not been created", () => {
  const { bots, threads } = createMockApi().getState()
  const remembered = { botId: "bot-panko", threadId: null }

  const target = getModeSelection("bots", threads, bots, remembered)

  expect(target).toEqual(remembered)
})

it("falls back within the mode when a remembered draft bot was deleted", () => {
  const { bots, threads } = createMockApi().getState()

  const target = getModeSelection("bots", threads, bots, { botId: "deleted-bot", threadId: null })

  expect(target?.botId).toBe("bot-mark")
  expect(target?.threadId).toBe("thread-mark")
})
