import { expect, it } from "vitest"
import { readWorkspaceState, saveWorkspaceState } from "../src/workspaceState"

it.each(["cron", "integracoes", "mcp", "work", "performance"])(
  "migrates the saved %s destination into Advanced",
  (page) => {
    localStorage.setItem(
      "touri.workspace.v1",
      JSON.stringify({ botId: "bot-a", threadId: "thread-a", route: { section: "touri", page } }),
    )
    expect(readWorkspaceState()).toEqual({
      botId: "bot-a",
      threadId: "thread-a",
      route: { section: "advanced", page },
    })
    saveWorkspaceState({ panelsByBot: { "bot-a": false } })
    expect(JSON.parse(localStorage.getItem("touri.workspace.v1") ?? "{}").route).toEqual({ section: "advanced", page })
  },
)

it.each(["chat", "preview"])("preserves the saved bot %s route and panel choice", (screen) => {
  const saved = { route: { section: "bots", screen }, panelsByBot: { "bot-a": true } }
  localStorage.setItem("touri.workspace.v1", JSON.stringify(saved))
  expect(readWorkspaceState()).toEqual(saved)
})

it("restores a bot-scoped routines route", () => {
  const route = { section: "advanced", page: "cron", botId: "bot-a" } as const
  saveWorkspaceState({ route })
  expect(readWorkspaceState().route).toEqual(route)
})

it.each([null, [], {}, { section: "touri", page: "missing" }, { section: "bots", screen: null }])(
  "ignores malformed saved routes: %j",
  (route) => {
    localStorage.setItem("touri.workspace.v1", JSON.stringify({ botId: "bot-a", route }))
    expect(readWorkspaceState()).toEqual({ botId: "bot-a" })
  },
)
