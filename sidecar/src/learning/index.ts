import type { BotLearning, Kernel } from "@touri/contracts"
import { readEntries, renderEntries } from "./memory"
import { createLearningReviewer } from "./review"
import { readLearning, readLearningState, writeLearning } from "./settings"
import { countSkills } from "./skills"
import {
  createMemoryWriteHandler,
  createSkillArchiveHandler,
  createSkillCreateHandler,
  createSkillPatchHandler,
} from "./tools"

export const name = "learning"

export const init = async (kernel: Kernel): Promise<void> => {
  const registration = kernel.registerTools({
    tools: [
      { name: "memory_write", group: "core", handler: createMemoryWriteHandler({ kernel }) },
      { name: "skill_create", group: "core", handler: createSkillCreateHandler({ kernel }) },
      { name: "skill_patch", group: "core", handler: createSkillPatchHandler({ kernel }) },
      { name: "skill_archive", group: "core", handler: createSkillArchiveHandler({ kernel }) },
    ],
  })
  if (!registration.success)
    kernel.log({
      level: "error",
      module: name,
      msg: "Unable to register learning tools",
      data: { errorCode: registration.errorCode },
    })
  const reviewer = createLearningReviewer(kernel)
  kernel.onHostNotification((notification) => {
    if (notification.method === "app.willQuit") reviewer.stop()
  })
  kernel.registerRoutes({
    name,
    routes: [
      {
        method: "GET",
        path: "/bots/:id/learning",
        handler: async ({ params }) => {
          const bot = kernel.services.use("store.api")?.getBot({ botId: params.id ?? "" })
          if (!bot) return { status: 404, json: { errorCode: "NOT_FOUND", error: "Bot não encontrado" } }
          return { status: 200, json: { learning: getSnapshot(kernel, bot.id, bot.homeDir) } }
        },
      },
      {
        method: "PUT",
        path: "/bots/:id/learning",
        handler: async ({ params, body }) => {
          const bot = kernel.services.use("store.api")?.getBot({ botId: params.id ?? "" })
          if (!bot) return { status: 404, json: { errorCode: "NOT_FOUND", error: "Bot não encontrado" } }
          const saved = writeLearning(kernel, bot.id, body)
          if (!saved.success) return { status: 400, json: { errorCode: "INVALID_ARGS", error: saved.error } }
          return { status: 200, json: { learning: getSnapshot(kernel, bot.id, bot.homeDir) } }
        },
      },
    ],
  })
  kernel.log({ level: "debug", module: name, msg: "initialized ./learning/index.ts" })
}

const getSnapshot = (kernel: Kernel, botId: string, homeDir: string): BotLearning => {
  const memory = getEntryUsage(homeDir, "memory")
  const user = getEntryUsage(homeDir, "user")

  return {
    ...readLearning(kernel, botId),
    ...readLearningState(kernel, botId),
    memoryChars: memory.chars,
    userChars: user.chars,
    ...(memory.error ? { memoryError: memory.error } : {}),
    ...(user.error ? { userError: user.error } : {}),
    skillCount: countSkills(homeDir),
  }
}

const getEntryUsage = (
  homeDir: string,
  target: "memory" | "user",
): { chars: number; error?: BotLearning["memoryError"] } => {
  try {
    return { chars: renderEntries(readEntries(homeDir, target)).length }
  } catch (error) {
    const reason = error instanceof Error && error.message === "INVALID_PATH" ? "INVALID_PATH" : "READ_ERROR"

    return { chars: 0, error: reason }
  }
}
