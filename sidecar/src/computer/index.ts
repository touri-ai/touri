import type { Kernel } from "@touri/contracts"
import type { PerformanceStageRunner } from "../kernel/performance"
import { createComputerController } from "./controller"
import { createComputerInput } from "./input-control"
import { createComputerRoutes } from "./routes"
import { createComputerTools } from "./tools"

export const name = "computer"

export const init = async (kernel: Kernel, runStage?: PerformanceStageRunner): Promise<void> => {
  kernel.services.provide("computer.input", createComputerInput(kernel))
  const controller = createComputerController(kernel, runStage ? { runStage } : {})
  const registration = kernel.registerTools({
    tools: createComputerTools({ controller }).map((tool) => ({
      ...tool,
      handler: async (input) => {
        const bot = kernel.services.use("store.api")?.getBot({ botId: input.ctx.botId })
        if (bot?.machine === "vm" && !bot.hostComputerUse) {
          if (!bot.computerUse)
            return { success: false, errorCode: "DENIED", error: "O controle do computador está desativado." }
          const writes = tool.name !== "computer_screenshot" && tool.name !== "computer_frontmost"
          if (writes && bot.access === "read-only")
            return { success: false, errorCode: "DENIED", error: "O bot está em modo somente leitura." }
          const present = kernel.services.use("approvals.present")
          if (!present) return { success: false, errorCode: "DENIED", error: "A ponte de aprovação está indisponível." }
          const approved = await present({
            ctx: input.ctx,
            scope: { source: "computer", tool: tool.name },
            toolName: tool.name,
            input: input.args,
            isCurrent: () => {
              const latest = kernel.services.use("store.api")?.getBot({ botId: input.ctx.botId })
              return (
                !!latest?.computerUse &&
                latest.machine === "vm" &&
                !latest.hostComputerUse &&
                !(writes && latest.access === "read-only")
              )
            },
          })
          if (!approved.success || approved.behavior !== "allow" || input.ctx.signal.aborted)
            return { success: false, errorCode: "DENIED", error: "A ação não foi aprovada." }
          const latestBot = kernel.services.use("store.api")?.getBot({ botId: input.ctx.botId })
          if (!latestBot?.computerUse || latestBot.machine !== "vm" || latestBot.hostComputerUse)
            return { success: false, errorCode: "DENIED", error: "O controle do computador foi desativado." }
          if (writes && latestBot.access === "read-only")
            return { success: false, errorCode: "DENIED", error: "O bot está em modo somente leitura." }
          const vm = kernel.services.use("vm.runtime")
          if (!vm) return { success: false, errorCode: "VM_UNAVAILABLE", error: "VM runtime indisponível" }
          return vm.computer({ ctx: input.ctx, name: tool.name, args: input.args })
        }
        return tool.handler(input)
      },
    })),
  })
  if (!registration.success) {
    kernel.log({
      level: "error",
      module: "computer",
      msg: "Unable to register computer MCP tools",
      data: { errorCode: registration.errorCode },
    })
  }
  kernel.registerRoutes(createComputerRoutes({ kernel, controller }))
  kernel.services.provide("computer.isActive", controller.isActive)
  kernel.onHostNotification((notification) => controller.handleHostNotification(notification.method))
  kernel.onHostNotification((notification) => {
    if (notification.method === "app.willQuit") controller.dispose()
  })
}
