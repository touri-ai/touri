import { afterEach, expect, mock, test } from "bun:test"
import type { Kernel, ToolContext } from "@touri/contracts"
import { createProjectStore } from "../../src/projects/repository"
import { createProjectInfo } from "../../src/projects/routes"
import { createSupervisor } from "../../src/projects/supervisor"
import { createProjectTools } from "../../src/projects/tools"
import type { ProjectStore, Supervisor } from "../../src/projects/types"
import { init as initStore } from "../../src/store"
import { testKernel } from "../kernel/test-kernel"

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

const cleanups = new Set<() => void>()
afterEach(() => {
  cleanups.forEach((close) => {
    close()
  })
  cleanups.clear()
})

test.each(["local", "vm"] as const)(
  "%s turn context reads stored metadata without probing files or processes",
  async (machine) => {
    const fixture = testKernel()
    cleanups.add(fixture.close)
    await initStore(fixture.kernel)
    fixture.db
      .query(
        "INSERT INTO projects(id,name,path,data_dir,created_at,updated_at) VALUES ('project-synthetic','Synthetic','/workspace/synthetic','/workspace/synthetic/.touri/data',1,1)",
      )
      .run()
    fixture.db
      .query(
        "INSERT INTO bots(id,name,provider,machine,home_dir,created_at,updated_at) VALUES ('bot-synthetic','Synthetic','codex',?, '/workspace/synthetic',1,1), ('other-bot','Other','codex','vm','/workspace/synthetic',1,1)",
      )
      .run(machine)
    const inspectRepository = mock(() => {
      throw new Error("Repository inspection must not delay a turn")
    })
    const kernel: Kernel = { ...fixture.kernel, shellEnv: inspectRepository, spawnTree: inspectRepository }
    const store = createProjectStore({ kernel })
    store.upsertSecret({
      projectId: "project-synthetic",
      name: "SYNTHETIC_KEY",
      usage: { env: true, browser: false },
      browserOrigin: null,
      now: 1,
    })
    const processes = [
      { name: "local", vmBotId: null },
      { name: "guest", vmBotId: "bot-synthetic" },
      { name: "other", vmBotId: "other-bot" },
    ].map((identity) =>
      store.upsertProcess({
        ...identity,
        projectId: "project-synthetic",
        command: "echo synthetic",
        cwd: "/workspace/synthetic",
        env: {},
        autostart: false,
        restart: "never",
        dependsOn: [],
        ready: null,
        previewPort: null,
        createdBy: "user",
        now: 1,
      }),
    )
    expect(processes.every((process) => process.success)).toBe(true)
    const guest = processes[1]
    if (!guest?.success) throw new Error("Missing synthetic process")
    store.insertProcessRun({
      id: "run-guest",
      processId: guest.spec.id,
      pid: null,
      pgid: null,
      pidStart: null,
      status: "running",
      logPath: "/workspace/synthetic.log",
      startedAt: 1,
    })
    store.updateProcessRun({
      runId: "run-guest",
      ports: [{ port: 3000, host: "127.0.0.1", pid: 1, detectedAt: 1, via: "log" }],
    })
    const supervisor = createSupervisor({ kernel, store })
    const getInfo = createProjectInfo({ kernel, store, supervisor })

    const context = await getInfo({ projectId: "project-synthetic", botId: "bot-synthetic", scope: "turn" })

    expect(inspectRepository).not.toHaveBeenCalled()
    expect(context?.secretNames).toEqual(["SYNTHETIC_KEY"])
    expect(context?.git).toBeNull()
    expect(context?.hints).toEqual([])
    expect(context?.project.path).toBe(machine === "vm" ? "/workspace" : "/workspace/synthetic")
    expect(context?.processes.map((process) => process.name)).toEqual(
      machine === "vm" ? ["guest"] : ["guest", "local", "other"],
    )
    expect(context?.processes.find((process) => process.name === "guest")?.ports).toEqual([3000])
  },
)
