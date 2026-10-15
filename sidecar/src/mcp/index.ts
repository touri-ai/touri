import { type Kernel, type ToolRegistration, toolCatalog } from "@touri/contracts"
import { touriVersion } from "../version"
import { registerAttachedMcpRoutes } from "./attached"
import { createToolRouter } from "./router"
import { createMcpSocket } from "./socket"
import { createHistoryReadHandler } from "./tools/history-read"
import { createHistorySearchHandler } from "./tools/history-search"
import { createNotifyUserHandler } from "./tools/notify-user"

export const name = "mcp"

const activeSockets = new WeakMap<Kernel, ReturnType<typeof createMcpSocket>>()

export const init = async (kernel: Kernel): Promise<void> => {
  const registrations = new Map<string, ToolRegistration>()
  const originalRegisterTools = kernel.registerTools
  kernel.registerTools = (input) => {
    const result = originalRegisterTools(input)
    if (result.success) for (const tool of input.tools) registrations.set(tool.name, tool)
    return result
  }

  const coreTools: Array<ToolRegistration> = [
    { name: "history_search", group: "core", handler: createHistorySearchHandler({ kernel }) },
    { name: "history_read", group: "core", handler: createHistoryReadHandler({ kernel }) },
    { name: "notify_user", group: "core", handler: createNotifyUserHandler({ kernel }) },
  ]
  const registration = kernel.registerTools({ tools: coreTools })
  if (!registration.success) {
    kernel.log({
      level: "error",
      module: "mcp",
      msg: "Unable to register core MCP tools",
      data: { errorCode: registration.errorCode },
    })
  }

  kernel.registerRoutes({
    name: "mcp-ui",
    routes: [
      {
        method: "GET",
        path: "/mcp/tools",
        handler: async () => ({
          status: 200,
          json: {
            server: { name: "touri", version: touriVersion },
            tools: [...registrations.entries()].flatMap(([name, tool]) => {
              const definition = toolCatalog.tools.find((candidate) => candidate.name === name)
              return definition ? [{ name, description: definition.description, group: tool.group }] : []
            }),
          },
        }),
      },
    ],
  })

  registerAttachedMcpRoutes(kernel)
  const router = createToolRouter({ kernel, registrations })
  kernel.services.provide("mcp.botTools", (bot) =>
    router
      .list({
        caller: {
          botId: bot.id,
          threadId: bot.mainThreadId ?? "",
          projectId: bot.projectId,
          cwd: bot.cwd ?? bot.homeDir,
          provider: bot.provider,
          browserEnabled: bot.browserEnabled,
          computerUse: bot.computerUse,
        },
      })
      .map((tool) => tool.name)
      .filter((name) => name !== "approval_prompt" && name !== "approval_context"),
  )
  const socket = createMcpSocket({ kernel, registrations })
  await socket.listen()
  activeSockets.set(kernel, socket)
  kernel.onHostNotification((notification) => {
    if (notification.method === "app.willQuit") void socket.close()
  })
  kernel.log({ level: "debug", module: "mcp", msg: "initialized ./mcp/index.ts" })
}

export const stop = async ({ kernel }: { kernel: Kernel }): Promise<void> => {
  const socket = activeSockets.get(kernel)
  if (!socket) return
  activeSockets.delete(kernel)
  await socket.close()
}
