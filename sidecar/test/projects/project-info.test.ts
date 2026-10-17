import { expect, mock, test } from "bun:test"
import type { Kernel, ToolContext } from "@touri/contracts"
import { createProjectTools } from "../../src/projects/tools"
import type { ProjectStore, Supervisor } from "../../src/projects/types"

test("project_info gives an unlinked bot a useful data connection hint without querying projects", async () => {
  const projectInfo = mock(async () => null)
  const tools = createProjectTools({
    kernel: {} as Kernel,
    store: {} as ProjectStore,
    supervisor: {} as Supervisor,
    projectInfo,
  })
  const tool = tools.find((tool) => tool.name === "project_info")
  if (!tool) throw new Error("Missing project_info")
  const ctx: ToolContext = {
    botId: "data-bot",
    threadId: "data-thread",
    runId: null,
    projectId: null,
    cwd: "/tmp/data-bot",
    signal: new AbortController().signal,
  }
  const result = await tool.handler({ ctx, args: {} })
  expect(result).toMatchObject({ success: true, structured: { project: null } })
  if (!result.success) throw new Error("Expected a setup hint")
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
  for (const hint of ["Nenhum projeto", "CSV", "pasta", "catálogo", "não conecta", "<!-- touri:connect-data -->"])
    expect(text).toContain(hint)
  expect(projectInfo).not.toHaveBeenCalled()
})
