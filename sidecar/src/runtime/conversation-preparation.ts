import type { Bot, Kernel, ProviderAdapter, ProviderSession, Thread } from "@touri/contracts"
import { delegatedBot } from "../groups/security"
import { buildChildEnv } from "../kernel"
import { providerProfileEnv } from "../kernel/provider-profiles"
import { attachedServers } from "../mcp/attached"
import { resolveMcpEndpoint } from "../platform/transport"
import { prepareLocalProviderLogin } from "../vm/local-provider-login"
import { composeDeveloperInstructions } from "./instructions"
import { sessionFingerprint, workingDirectory } from "./session"

export const prepareConversationSession = async ({
  kernel,
  bot,
  thread,
  session,
  prepare,
  environment,
  signal,
}: {
  kernel: Kernel
  bot: Bot
  thread: Thread
  session: ProviderSession | null
  prepare: NonNullable<ProviderAdapter["prepareSession"]>
  environment?: Record<string, string>
  signal: AbortSignal
}): Promise<boolean> => {
  const { cwd, projectDataDir } = await workingDirectory({ kernel, bot, thread })
  const mcp = { command: kernel.paths.sidecarBinary, args: ["mcp-stdio", "--thread", thread.id], env: {} }
  const identity = sessionFingerprint({
    bot: delegatedBot(kernel, thread.id, { ...bot, mcpServers: attachedServers(kernel, bot.id) }),
    cwd,
    mcpCommand: mcp.command,
    mcpArgs: mcp.args,
    conversationOnly: true,
  })
  const turnBot = delegatedBot(kernel, thread.id, { ...bot, mcpServers: [], reasoningEffort: "low" })
  const developerInstructions = await composeDeveloperInstructions({
    kernel,
    bot: turnBot,
    thread,
    cwd,
    greetingOnly: true,
    allowMemoryReview: false,
    signal,
  })
  const base = environment?.PATH ? environment : await kernel.shellEnv()
  const env = buildChildEnv({
    base,
    overrides: {
      ...environment,
      ...providerProfileEnv({ appData: kernel.paths.appData, bot }),
      TOURI_RUN_DIR: kernel.paths.runDir,
      TOURI_APP_DATA: kernel.paths.appData,
      TOURI_MCP_SOCK: resolveMcpEndpoint(kernel.paths),
      ...(projectDataDir ? { TOURI_PROJECT_DATA_DIR: projectDataDir } : {}),
    },
  })
  signal.throwIfAborted()
  const login = await prepareLocalProviderLogin(kernel, bot, signal, env.HOME)
  const result = await prepare({
    conversationOnly: true,
    bot: turnBot,
    thread,
    session: session?.fingerprint === identity.hash ? session : null,
    fingerprint: identity.fingerprint,
    developerInstructions,
    env: { ...env, ...login.env },
    mcp,
    input: [],
    handoffPacket: null,
    signal,
    onEvent: () => undefined,
  }).finally(() => login.release())
  return result.success
}
