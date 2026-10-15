import type { Database } from "bun:sqlite"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Bot, Kernel, McpServer, McpTool } from "@touri/contracts"
import { createStandingGrantStore, registerStandingGrantRoutes } from "../approvals/grants"
import { buildChildEnv } from "../kernel/shell-env"
import { touriVersion } from "../version"

const connectionKey = (server: McpServer): string =>
  JSON.stringify(
    server.transport === "stdio"
      ? { transport: server.transport, command: server.command, args: server.args }
      : { transport: server.transport, url: server.url },
  )

export const attachedServers = (kernel: Kernel, botId: string): McpServer[] => {
  if (typeof (kernel.db as Database).query !== "function") return []
  return (
    (kernel.db as Database)
      .query("SELECT config_json FROM bot_mcp_servers WHERE bot_id = ? ORDER BY name")
      .all(botId) as Array<{ config_json: string }>
  ).map((row) => {
    const server = JSON.parse(row.config_json) as McpServer
    return { ...server, tools: server.tools.map(normalizedTool) }
  })
}

export const validateMcpServer = (value: unknown): McpServer => {
  if (!value || typeof value !== "object") throw new Error("Servidor MCP inválido")
  const server = value as Record<string, unknown>
  if (typeof server.name !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(server.name) || server.name === "touri")
    throw new Error("Escolha um nome MCP válido e diferente de touri")
  if (
    server.transport === "stdio" &&
    typeof server.command === "string" &&
    server.command.trim() &&
    Array.isArray(server.args) &&
    server.args.every((arg) => typeof arg === "string")
  )
    return { name: server.name, transport: "stdio", command: server.command, args: server.args, tools: [] }
  if (server.transport === "http" && typeof server.url === "string") {
    const url = new URL(server.url)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("URL MCP inválida")
    return { name: server.name, transport: "http", url: url.toString(), tools: [] }
  }
  throw new Error("Informe um comando stdio com argumentos ou uma URL HTTP")
}

export const withAttachedClient = async <T>(
  kernel: Kernel,
  bot: Bot,
  server: McpServer,
  operation: (client: Client) => Promise<T>,
  timeoutMs = 5000,
  signal?: AbortSignal,
): Promise<T> => {
  const client = new Client({ name: "touri-config", version: touriVersion })
  const transport =
    server.transport === "http"
      ? new StreamableHTTPClientTransport(new URL(server.url))
      : new StdioClientTransport({
          command: server.command,
          args: server.args,
          env: buildChildEnv({ base: await kernel.shellEnv() }),
          stderr: "pipe",
        })
  // Probe in the same machine where this bot's CLI runs.
  let release: (() => Promise<void>) | undefined
  let guest: ReturnType<Kernel["spawnTree"]> | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let guestClosed = false
  const guestTransport = {
    onmessage: undefined as
      | ((message: import("@modelcontextprotocol/sdk/types.js").JSONRPCMessage) => void)
      | undefined,
    onerror: undefined as ((error: Error) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    async start() {
      const vm = kernel.services.use("vm.runtime")
      if (!vm || server.transport !== "stdio") throw new Error("Máquina MCP indisponível")
      const acquired = await vm.acquire({ botId: bot.id })
      if (guestClosed || signal?.aborted) {
        await acquired()
        throw new Error("A conexão MCP foi cancelada.")
      }
      release = acquired
      guest = vm.spawn({ botId: bot.id, cmd: server.command, args: server.args, cwd: "/workspace", env: {} })
      if (!guest.success) throw new Error(guest.error)
      reader = guest.stdout.getReader()
      const consume = async () => {
        let buffer = ""
        const decoder = new TextDecoder()
        while (reader) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true })
          let end = buffer.indexOf("\n")
          while (end >= 0) {
            const line = buffer.slice(0, end).trim()
            buffer = buffer.slice(end + 1)
            if (line) this.onmessage?.(JSON.parse(line))
            end = buffer.indexOf("\n")
          }
        }
      }
      void consume().catch((error: Error) => this.onerror?.(error))
      void new Response(guest.stderr).text()
    },
    async send(message: import("@modelcontextprotocol/sdk/types.js").JSONRPCMessage) {
      if (!guest?.success) throw new Error("MCP não conectado")
      const writer = guest.stdin.getWriter()
      try {
        await writer.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`))
      } finally {
        writer.releaseLock()
      }
    },
    async close() {
      if (guestClosed) return
      guestClosed = true
      if (guest?.success) guest.kill("SIGTERM")
      await reader?.cancel().catch(() => undefined)
      reader = undefined
      await release?.()
      this.onclose?.()
    },
  }
  const selected = bot.machine === "vm" && server.transport === "stdio" ? guestTransport : transport
  let timer: ReturnType<typeof setTimeout> | undefined
  const abort = () => {
    void selected.close().catch(() => undefined)
  }
  signal?.throwIfAborted()
  signal?.addEventListener("abort", abort, { once: true })
  try {
    const probe = (async () => {
      await client.connect(selected as unknown as import("@modelcontextprotocol/sdk/shared/transport.js").Transport)
      signal?.throwIfAborted()
      return operation(client)
    })()
    return await Promise.race([
      probe,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Servidor MCP não respondeu no prazo")), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
    await client.close().catch(() => undefined)
  }
}

export const normalizedTool = (tool: McpTool): McpTool => {
  const classification = tool.classification === "reads" ? "reads" : "writes"
  return {
    ...tool,
    classification,
    policy:
      tool.policy === "always_allow" || tool.policy === "blocked" || tool.policy === "needs_approval"
        ? tool.policy
        : classification === "reads"
          ? "always_allow"
          : "needs_approval",
  }
}

export const discoverMcpTools = (kernel: Kernel, bot: Bot, server: McpServer): Promise<McpServer> =>
  withAttachedClient(kernel, bot, server, async (client) => {
    const tools: McpTool[] = []
    let cursor: string | undefined
    do {
      const response = await client.listTools(cursor ? { cursor } : {})
      tools.push(
        ...response.tools.map((tool) => {
          const previous = server.tools.find((value) => value.name === tool.name)
          return normalizedTool({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: tool.inputSchema,
            classification: previous?.classification ?? (tool.annotations?.readOnlyHint === true ? "reads" : "writes"),
            ...(previous?.policy ? { policy: previous.policy } : {}),
          })
        }),
      )
      cursor = response.nextCursor
    } while (cursor)
    return { ...server, tools }
  })

export const resolveAttachedMcp = async (kernel: Kernel, bot: Bot): Promise<McpServer[]> => {
  const resolved: McpServer[] = []
  for (const server of attachedServers(kernel, bot.id)) {
    try {
      const discovered = await discoverMcpTools(kernel, bot, server)
      const latest = attachedServers(kernel, bot.id).find((value) => value.name === server.name)
      if (!latest || connectionKey(latest) !== connectionKey(server)) continue
      const tools = discovered.tools.map((tool) => {
        const current = latest.tools.find((value) => value.name === tool.name)
        return current ? { ...tool, classification: current.classification, policy: current.policy } : tool
      }) as McpTool[]
      const updated = { ...latest, tools }
      ;(kernel.db as Database)
        .query("UPDATE bot_mcp_servers SET config_json = ? WHERE bot_id = ? AND name = ?")
        .run(JSON.stringify(updated), bot.id, server.name)
      resolved.push(updated)
    } catch {
      kernel.log({ level: "warn", module: "mcp", msg: `MCP ${server.name} indisponível para ${bot.id}` })
    }
  }
  return resolved
}

export const registerAttachedMcpRoutes = (kernel: Kernel): void => {
  registerStandingGrantRoutes(kernel)
  const grants = createStandingGrantStore(kernel)
  kernel.registerRoutes({
    name: "bot-mcp",
    routes: [
      {
        method: "GET",
        path: "/bots/:id/mcp",
        handler: async ({ params }) => ({ status: 200, json: { servers: attachedServers(kernel, params.id ?? "") } }),
      },
      {
        method: "PUT",
        path: "/bots/:id/mcp/:name",
        handler: async ({ params, body }) => {
          const bot = kernel.services.use("store.api")?.getBot({ botId: params.id ?? "" })
          if (!bot) return { status: 404, json: { error: "Bot não encontrado" } }
          try {
            const config = validateMcpServer({ ...(body as object), name: params.name })
            const previous = attachedServers(kernel, bot.id).find((server) => server.name === config.name)
            const sameConnection = previous && connectionKey(previous) === connectionKey(config)
            const server = await discoverMcpTools(kernel, bot, {
              ...config,
              tools: sameConnection ? previous.tools : [],
            })
            const latest = attachedServers(kernel, bot.id).find((value) => value.name === config.name)
            if (JSON.stringify(latest) !== JSON.stringify(previous))
              return { status: 409, json: { error: "A configuração MCP mudou durante a conexão. Tente novamente." } }
            if (previous && !sameConnection) grants.revokeServer(bot.id, config.name)
            ;(kernel.db as Database)
              .query(
                "INSERT INTO bot_mcp_servers(bot_id, name, config_json) VALUES (?, ?, ?) ON CONFLICT(bot_id, name) DO UPDATE SET config_json = excluded.config_json",
              )
              .run(bot.id, server.name, JSON.stringify(server))
            return { status: 200, json: { server } }
          } catch (error) {
            return {
              status: 400,
              json: { error: kernel.redact(error instanceof Error ? error.message : "MCP indisponível") },
            }
          }
        },
      },
      {
        method: "PATCH",
        path: "/bots/:id/mcp/:name/tools/:tool",
        handler: async ({ params, body }) => {
          const server = attachedServers(kernel, params.id ?? "").find((value) => value.name === params.name)
          const tool = server?.tools.find((value) => value.name === params.tool)
          if (!server || !tool) return { status: 404, json: { error: "Ferramenta não encontrada." } }
          const input = body as { classification?: unknown; policy?: unknown } | null
          if (
            !input ||
            (input.classification !== "reads" && input.classification !== "writes") ||
            (input.policy !== "always_allow" && input.policy !== "needs_approval" && input.policy !== "blocked")
          )
            return { status: 400, json: { error: "Classificação ou política inválida." } }
          tool.classification = input.classification as NonNullable<McpTool["classification"]>
          tool.policy = input.policy as NonNullable<McpTool["policy"]>
          const grant = grants
            .list(params.id ?? "")
            .find(
              (value) =>
                value.scope.source === "mcp" && value.scope.server === server.name && value.scope.tool === tool.name,
            )
          if (grant) grants.revoke(params.id ?? "", grant.id)
          ;(kernel.db as Database)
            .query("UPDATE bot_mcp_servers SET config_json = ? WHERE bot_id = ? AND name = ?")
            .run(JSON.stringify(server), params.id ?? "", server.name)
          return { status: 200, json: { server } }
        },
      },
      {
        method: "DELETE",
        path: "/bots/:id/mcp/:name",
        handler: async ({ params }) => {
          grants.revokeServer(params.id ?? "", params.name ?? "")
          ;(kernel.db as Database)
            .query("DELETE FROM bot_mcp_servers WHERE bot_id = ? AND name = ?")
            .run(params.id ?? "", params.name ?? "")
          return { status: 200, json: {} }
        },
      },
    ],
  })
}
