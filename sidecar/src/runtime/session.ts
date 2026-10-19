import { mkdir, stat } from "node:fs/promises"
import type { Bot, Kernel, SessionFingerprint, Thread } from "@touri/contracts"
import { botFolderFingerprint } from "../kernel/bot-folders"
import { canonicalJson, sha256 } from "./utils"

export const sessionFingerprint = ({
  bot,
  cwd,
  mcpCommand,
  mcpArgs,
}: {
  bot: Bot
  cwd: string
  mcpCommand: string
  mcpArgs: Array<string>
}): { fingerprint: SessionFingerprint; hash: string } => {
  const fingerprint: SessionFingerprint = {
    provider: bot.provider,
    cwd,
    access: bot.access,
    mcpServers: [
      { name: "touri", command: mcpCommand, args: mcpArgs },
      ...(bot.mcpServers ?? []).map((server) => ({
        name: server.name,
        command: server.transport === "stdio" ? server.command : `http:${server.url}`,
        args: server.transport === "stdio" ? server.args : [],
      })),
    ],
    // Sessions live in the CLI home, so a profile switch must start a new native session.
    // Appended only when set, so existing sessions keep their hash.
    toolsetVersion: `touri-tools-3:folders=${botFolderFingerprint(bot)}:browser=${bot.browserEnabled}:computer=${bot.computerUse}:approvals=${bot.approvals}${bot.providerProfile ? `:profile=${bot.providerProfile}` : ""}${bot.claudeAiConnectors ? ":connectors=claude-ai" : ""}`,
  }
  return { fingerprint, hash: sha256(canonicalJson(fingerprint)) }
}

const usableDirectory = async (path: string): Promise<boolean> => {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 })
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export const workingDirectory = async ({
  kernel,
  bot,
  thread,
}: {
  kernel: Kernel
  bot: Bot
  thread: Thread
}): Promise<{ cwd: string; projectDataDir: string | null }> => {
  const projectService = bot.projectId ? kernel.services.use("projects.info") : null
  const info = projectService && bot.projectId ? await projectService({ projectId: bot.projectId }) : null
  const candidates = [thread.cwdOverride, bot.cwd, info?.project.path].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  )
  let cwd = bot.homeDir
  for (const candidate of candidates) {
    if (!(await usableDirectory(candidate))) continue
    cwd = candidate
    break
  }
  await usableDirectory(cwd)
  return { cwd, projectDataDir: info?.project.dataDir ?? null }
}
