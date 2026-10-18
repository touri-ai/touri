import type { Kernel } from "@touri/contracts"
import type { PerformanceStageRunner } from "../kernel/performance"
import { createFolderRoutes } from "./folders"
import { createProjectStore } from "./repository"
import { createProjectInfo, createProjectRoutes } from "./routes"
import { createSupervisor } from "./supervisor"
import { createProjectTools } from "./tools"

export const name = "projects"

export const init = async (kernel: Kernel, runStage?: PerformanceStageRunner): Promise<void> => {
  const store = createProjectStore({ kernel })
  const supervisor = createSupervisor({ kernel, store, ...(runStage ? { runStage } : {}) })
  const projectInfo = createProjectInfo({ kernel, store, supervisor })
  kernel.services.provide("projects.info", projectInfo)
  kernel.registerRoutes(createFolderRoutes({ appData: kernel.paths.appData }))
  kernel.registerRoutes(createProjectRoutes({ kernel, store, supervisor }))
  const registration = kernel.registerTools({ tools: createProjectTools({ kernel, store, supervisor, projectInfo }) })
  if (!registration.success)
    kernel.log({ level: "error", module: name, msg: registration.error, data: { errorCode: registration.errorCode } })
  await supervisor.cleanupOrphans()
  await supervisor.autostart()
  kernel.subscribe(({ event }) => {
    if (event.type === "machine.updated" && event.machine.status === "running") void supervisor.autostart()
  })
  kernel.onHostNotification((notification) => {
    if (notification.method === "app.willQuit") void supervisor.stopAll()
  })
}
