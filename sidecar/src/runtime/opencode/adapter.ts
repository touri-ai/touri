import { randomUUID } from "node:crypto"
import type { Kernel, ProviderAdapter, StartTurnArgs, StartTurnResult } from "@touri/contracts"
import { getApiModel } from "../../api-models/config"
import { startApiModelProxy } from "../../api-models/proxy"
import { getApiModelEnv, getApiOpenCodeConfig, getApiRunError } from "../../api-models/runtime"
import { getDelegation } from "../../groups/security"
import { buildChildEnv } from "../../kernel"
import { writePrivateFileAsync } from "../../kernel/async-files"
import { getSavedBotModel } from "../../store/model"
import { spawnFolderProvider } from "../folder-access"
import { loadTurnImages } from "../loadTurnImages"
import { withLocalTurnTemp } from "../local-turn-temp"
import { mcpStartupError } from "../mcp-startup"
import { applyProviderPrivacy, cliTelemetryOff } from "../privacy"
import { type ChildProcess, readProviderStderr, startLineReader } from "../provider-io"
import { stopProviderChildren, trackProviderProcess } from "../provider-processes"
import { asRecord, canonicalJson, classifyProviderError } from "../utils"
import {
  credentialAuth,
  fullAccess,
  isolatedOpenCodeEnv,
  openCodeAuthPath,
  openCodeBinary,
  openCodeConfig,
  providerSecretEnv,
  readOpenCodeAuth,
} from "./config"
import { openCodeEvents, readOpenCodeSse } from "./events"

const modelSpec = (id: string) => {
  const slash = id.indexOf("/")
  if (slash < 1 || slash === id.length - 1) throw new Error("Use o modelo no formato provedor/modelo")
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) }
}
export const deepSeekDefault = (models: string[]): string | null =>
  models.find((id) => id === "openrouter/deepseek/deepseek-v3.2") ??
  models.find((id) => id.startsWith("openrouter/deepseek/") && /deepseek-v3|deepseek-chat/.test(id)) ??
  models.find((id) => id.startsWith("openrouter/deepseek/")) ??
  null

export const createOpenCodeAdapter = ({
  kernel,
  command,
  interruptGraceMs = 2000,
  startupMs = 30_000,
}: {
  kernel: Kernel
  command?: string
  interruptGraceMs?: number
  startupMs?: number
}): ProviderAdapter => {
  const children = new Set<ChildProcess>()
  const turns = new Set<AbortController>()
  const approvals = new Map<string, (decision: "approved" | "denied") => Promise<void>>()
  const stop = (child: ChildProcess) => {
    child.kill("SIGTERM")
    const timer = setTimeout(() => child.kill("SIGKILL"), interruptGraceMs)
    void child.exited.finally(() => clearTimeout(timer)).catch(() => {})
  }
  const startAttempt = async (args: StartTurnArgs): Promise<StartTurnResult> => {
    let child: ChildProcess | undefined
    let stopReader: (() => void) | undefined
    let sessionID = args.session?.externalSessionId ?? ""
    const ownApprovals = new Set<string>()
    const shutdown = new AbortController()
    turns.add(shutdown)
    const signal = AbortSignal.any([args.signal, shutdown.signal])
    let abortNative: (() => Promise<void>) | undefined
    let cleanupAuth: (() => Promise<void>) | undefined
    let cleanupApi: (() => Promise<void>) | undefined
    let request: ((path: string, body?: unknown) => Promise<unknown>) | undefined
    let diagnostics = ""
    let protocolError: Error | undefined
    try {
      args.signal.throwIfAborted()
      const apiModel = getApiModel(kernel, args.bot.model)
      const apiEnv = await getApiModelEnv(kernel, args.bot.model, signal)
      const base = args.execution ? { ...args.env } : buildChildEnv({ base: process.env, overrides: args.env })
      Object.assign(
        base,
        apiModel
          ? {}
          : await providerSecretEnv(
              kernel,
              args.bot,
              args.signal,
              getDelegation(kernel, args.thread.id)?.secrets !== false,
            ),
      )
      for (const [key, value] of Object.entries(base))
        if (/API_KEY|TOKEN|SECRET|PASSWORD/.test(key)) kernel.addRedactionValue(value)
      const binary = args.execution ? { success: true as const, path: "opencode" } : openCodeBinary(base, command)
      if (!binary.success)
        return {
          ...binary,
          error: "OpenCode não encontrado. Instale pelo terminal: curl -fsSL https://opencode.ai/install | bash",
        }
      const root = `${base.TOURI_RUN_DIR ?? kernel.paths.runDir}/opencode/${randomUUID()}`
      const dataDir = `${args.bot.homeDir}/.touri-opencode/${args.thread.id}/data`
      const configPath = `${root}/opencode.json`
      const write =
        args.execution?.writeFile ??
        ((file: { path: string; content: string }) => writePrivateFileAsync({ root: kernel.paths.appData, ...file }))
      const apiProxy = apiModel
        ? await startApiModelProxy({
            model: apiModel,
            key: apiEnv.TOURI_MODEL_API_KEY ?? "",
            args,
            root,
            write,
            signal,
          })
        : null
      cleanupApi = apiProxy?.close
      const executionBase = Object.assign({}, base, apiProxy ? { TOURI_MODEL_API_KEY: apiProxy.token } : {})
      const config = Object.assign({}, openCodeConfig(args), getApiOpenCodeConfig(apiModel, apiProxy?.url))
      await write({ path: configPath, content: JSON.stringify(config) })
      // These sentinel files create the directories privately, including in the guest.
      for (const dir of ["home", "config", "managed", "xdg-config"])
        await write({ path: `${root}/${dir}/.touri`, content: "" })
      let auth = "{}"
      if (!apiModel && args.execution) {
        const source = args.execution.spawn({
          cmd: "cat",
          args: [openCodeAuthPath(base.HOME ?? "/workspace/.home")],
          cwd: args.fingerprint.cwd,
          env: base,
        })
        if (source.success) {
          const [content, , exit] = await Promise.all([
            new Response(source.stdout).text(),
            new Response(source.stderr).text(),
            source.exited,
          ])
          if (exit.code === 0) auth = credentialAuth(content, kernel)
        }
      } else if (!apiModel) auth = readOpenCodeAuth(kernel, base)
      await write({ path: `${dataDir}/opencode/auth.json`, content: auth })
      cleanupAuth = async () => {
        await write({ path: `${dataDir}/opencode/auth.json`, content: "{}" })
      }
      const env = applyProviderPrivacy(
        isolatedOpenCodeEnv(executionBase, root, dataDir, configPath),
        cliTelemetryOff(kernel),
      )
      env.OPENCODE_SERVER_PASSWORD = randomUUID()
      kernel.addRedactionValue(env.OPENCODE_SERVER_PASSWORD)
      const spawned = spawnFolderProvider(kernel, args, {
        cmd: binary.path,
        args: ["serve", "--hostname", "127.0.0.1", "--port", "0", "--pure"],
        cwd: args.fingerprint.cwd,
        env,
      })
      if (!spawned.success)
        return {
          success: false,
          errorCode: spawned.errorCode === "ENOENT" ? "cli_missing" : "cli_crash",
          error: kernel.redact(spawned.error),
        }
      child = spawned
      children.add(child)
      if (!args.execution) await trackProviderProcess(kernel, child)
      let ready: (port: number) => void = () => {}
      const portPromise = new Promise<number>((resolve) => {
        ready = resolve
      })
      stopReader = startLineReader({
        stream: child.stdout,
        onLine: (line) => {
          const match = line.match(/(?:listening on|server listening).*?http:\/\/127\.0\.0\.1:(\d+)/i)
          if (match) ready(Number(match[1]))
        },
        onError: (error) => {
          protocolError = error
          shutdown.abort()
        },
      })
      void readProviderStderr(child.stderr, (text) => {
        diagnostics = kernel.redact(text)
      }).catch(() => {})
      const died = child.exited.then(() => {
        if (!shutdown.signal.aborted) shutdown.abort(new Error("O OpenCode encerrou inesperadamente"))
      })
      void died.catch(() => shutdown.abort())
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(startupMs)])
      const port = await new Promise<number>((resolve, reject) => {
        const abort = () => reject(deadline.reason)
        deadline.addEventListener("abort", abort, { once: true })
        void portPromise.then((port) => {
          deadline.removeEventListener("abort", abort)
          resolve(port)
        })
        if (deadline.aborted) abort()
      })
      const url = args.execution?.connect ? await args.execution.connect(port) : `http://127.0.0.1:${port}`
      if (args.execution && !args.execution.connect) throw new Error("Conexão HTTP da máquina indisponível")
      const headers = {
        Authorization: `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`,
        "Content-Type": "application/json",
      }
      request = async (path, body) => {
        const response = await fetch(`${url}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers,
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        if (!response.ok) {
          const error = new Error(
            response.status === 404 && args.session
              ? "A sessão do OpenCode não está disponível"
              : `OpenCode HTTP ${response.status}: ${kernel.redact(await response.text()).slice(0, 2000)}`,
          )
          throw error
        }
        return response.status === 204 ? null : await response.json()
      }
      abortNative = async () => {
        if (!sessionID) return
        await fetch(`${url}/session/${encodeURIComponent(sessionID)}/abort`, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(1500),
        })
      }
      const effective = asRecord(await request("/config"))
      // Managed settings on macOS can override inline config. Fail before a prompt
      // if the effective policy or tool sources differ from the private config.
      const agent = asRecord(asRecord(effective?.agent)?.touri)
      if (
        !effective ||
        canonicalJson(effective.permission) !== canonicalJson(config.permission) ||
        canonicalJson(agent?.permission) !== canonicalJson(config.permission) ||
        canonicalJson(effective.mcp) !== canonicalJson(config.mcp) ||
        (Array.isArray(effective.plugin) && effective.plugin.length > 0) ||
        (asRecord(effective.tools) && Object.keys(asRecord(effective.tools) ?? {}).length > 0)
      )
        throw new Error("Configurações externas alteraram as permissões do OpenCode; o turno foi bloqueado")
      const mcp = asRecord(await request("/mcp"))
      const touriStatus = asRecord(mcp?.touri)
      if (!args.conversationOnly && touriStatus?.status !== "connected")
        return {
          success: false,
          errorCode: "cli_protocol",
          error: mcpStartupError({ diagnostic: JSON.stringify(touriStatus ?? {}) }),
        }
      let model = args.bot.model
      if (!model) {
        const providers = asRecord(await request("/provider"))
        const connected = Array.isArray(providers?.connected) ? providers.connected : []
        const router = Array.isArray(providers?.all)
          ? providers.all.map(asRecord).find((p) => p?.id === "openrouter" && connected.includes("openrouter"))
          : null
        if (router) model = deepSeekDefault(Object.keys(asRecord(router.models) ?? {}).map((id) => `openrouter/${id}`))
      }
      if (args.session) await request(`/session/${encodeURIComponent(sessionID)}`)
      else {
        const session = asRecord(
          await request("/session", {
            title: args.thread.title,
            permission: Object.entries(config.permission).map(([permission, action]) => ({
              permission,
              pattern: "*",
              action,
            })),
          }),
        )
        if (typeof session?.id !== "string") throw new Error("O OpenCode não retornou uma sessão")
        sessionID = session.id
      }
      args.onEvent({ type: "session", externalSessionId: sessionID, rolloutPath: null })
      const events = await fetch(`${url}/event`, { headers, signal })
      if (!events.ok || !events.body) throw new Error("Fluxo SSE do OpenCode indisponível")
      let finish: (value: StartTurnResult) => void = () => {}
      const result = new Promise<StartTurnResult>((resolve) => {
        finish = resolve
      })
      let submitted = false
      // OpenCode IDs encode message ordering. Let the server assign them so
      // completion detection and resumed turns retain their native ordering.
      const translate = openCodeEvents(sessionID, args.onEvent, undefined, apiModel ? getApiRunError : undefined)
      const stream = readOpenCodeSse(events.body, (frame) => {
        const translated = translate(frame)
        if (translated.error)
          finish({
            success: false,
            errorCode: translated.errorCode ?? classifyProviderError(translated.error),
            error: kernel.redact(translated.error),
          })
        if (translated.idle && submitted) {
          args.onEvent({ type: "turn_completed", status: "succeeded", errorClass: null, errorMessage: null })
          finish({ success: true, externalSessionId: sessionID, rolloutPath: null, status: "succeeded" })
        }
        if (translated.permission) {
          const permission = translated.permission
          const reply = async (decision: "approved" | "denied") => {
            await request?.(
              permission.api === "v2"
                ? `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(permission.id)}/reply`
                : `/permission/${encodeURIComponent(permission.id)}/reply`,
              {
                reply: decision === "approved" ? "once" : "reject",
              },
            )
            approvals.delete(approvalId)
          }
          const approvalId = kernel.newId()
          if (args.bot.access === "read-only" || fullAccess(args.bot)) {
            void reply(fullAccess(args.bot) ? "approved" : "denied").catch((error) => {
              protocolError = error
              shutdown.abort()
            })
          } else {
            ownApprovals.add(approvalId)
            approvals.set(approvalId, reply)
            args.onEvent({
              type: "approval_request",
              approvalId,
              part: {
                type: "approval",
                approvalId,
                request: "permission",
                detail: kernel.redact(JSON.stringify({ patterns: permission.patterns, metadata: permission.metadata })),
                scope: { source: "opencode", tool: permission.permission },
                allowStanding: false,
                decision: "pending",
              },
            })
          }
        }
      })
        .then(() => {
          if (!signal.aborted) {
            protocolError = new Error("O fluxo SSE do OpenCode encerrou antes do fim do turno")
            shutdown.abort()
          }
        })
        .catch((error) => {
          if (!signal.aborted) {
            protocolError = error
            shutdown.abort()
          }
        })
      void stream
      const abortResult = new Promise<StartTurnResult>((resolve) => {
        signal.addEventListener(
          "abort",
          () =>
            resolve(
              args.signal.aborted
                ? { success: true, externalSessionId: sessionID, rolloutPath: null, status: "interrupted" }
                : {
                    success: false,
                    errorCode: protocolError ? "cli_protocol" : "cli_crash",
                    error: kernel.redact(protocolError?.message ?? diagnostics ?? "OpenCode encerrou"),
                  },
            ),
          { once: true },
        )
      })
      const loaded = loadTurnImages({ kernel, input: args.input })
      if (!loaded.success) throw new Error(loaded.error)
      const images = loaded.images.map((image) => ({
        type: "file",
        mime: image.mime,
        url: `data:${image.mime};base64,${image.base64}`,
      }))
      submitted = true
      await request(`/session/${encodeURIComponent(sessionID)}/prompt_async`, {
        agent: "touri",
        ...(args.conversationOnly ? { tools: { "*": false } } : {}),
        system: args.developerInstructions,
        ...(model ? { model: modelSpec(model) } : {}),
        ...(args.bot.reasoningEffort ? { variant: args.bot.reasoningEffort } : {}),
        parts: [
          {
            type: "text",
            text: [args.handoffPacket, ...args.input.flatMap((part) => (part.type === "text" ? [part.text] : []))]
              .filter(Boolean)
              .join("\n\n"),
          },
          ...images,
        ],
      })
      args.onEvent({ type: "turn_started", externalTurnId: randomUUID() })
      return await Promise.race([result, abortResult])
    } catch (error) {
      if (args.signal.aborted)
        return { success: true, externalSessionId: sessionID, rolloutPath: null, status: "interrupted" }
      const message = kernel.redact(error instanceof Error ? error.message : String(error))
      if (args.bot.model?.startsWith("touri-api-") && !protocolError && !shutdown.signal.aborted) {
        const mapped = getApiRunError(message)
        return { success: false, errorCode: mapped.errorClass, error: mapped.message }
      }
      return {
        success: false,
        errorCode:
          protocolError || /sessão|configurações|SSE|Evento|JSON|permissões/i.test(message)
            ? "cli_protocol"
            : error instanceof Error && error.name === "TimeoutError"
              ? "timeout"
              : shutdown.signal.aborted
                ? "cli_crash"
                : /timeout|timed out/i.test(message)
                  ? "timeout"
                  : classifyProviderError(`${message}\n${diagnostics}`),
        error: message,
      }
    } finally {
      turns.delete(shutdown)
      for (const id of ownApprovals) approvals.delete(id)
      if (args.signal.aborted) await abortNative?.().catch(() => {})
      shutdown.abort()
      await cleanupAuth?.().catch(() => {})
      stopReader?.()
      if (child) {
        stop(child)
        children.delete(child)
      }
      await cleanupApi?.().catch(() => {})
    }
  }
  const startTurn: ProviderAdapter["startTurn"] = async (args) => {
    const model = getSavedBotModel(args.bot.model)
    if (!model.success) return model

    const turnArgs = Object.assign({}, args, { bot: Object.assign({}, args.bot, { model: model.model }) })
    return withLocalTurnTemp(kernel, turnArgs, startAttempt)
  }

  return {
    provider: "opencode",
    startTurn,
    detect: async () => {
      const env = buildChildEnv({ base: await kernel.shellEnv() })
      const binary = openCodeBinary(env, command)
      if (!binary.success) return binary
      const child = kernel.spawnTree({ cmd: binary.path, args: ["--version"], cwd: kernel.paths.appData, env })
      if (!child.success)
        return { success: false, errorCode: "cli_missing", error: "Não foi possível executar o OpenCode" }
      const timer = setTimeout(() => child.kill("SIGKILL"), 4000)
      try {
        const [output, , exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        if (exit.code !== 0)
          return { success: false, errorCode: "cli_missing", error: "Não foi possível verificar a versão do OpenCode" }
        return {
          success: true,
          path: binary.path,
          version: output.trim(),
          loggedIn:
            Object.keys(JSON.parse(readOpenCodeAuth(kernel, env))).length > 0 ||
            Object.keys(env).some((key) => /_API_KEY$/.test(key) && !!env[key]),
        }
      } finally {
        clearTimeout(timer)
      }
    },
    answerApproval: async ({ approvalId, decision }) => {
      const reply = approvals.get(approvalId)
      if (!reply) return { success: false, errorCode: "NOT_FOUND", error: "Aprovação não encontrada" }
      try {
        await reply(decision)
        return { success: true }
      } catch {
        return { success: false, errorCode: "NOT_FOUND", error: "A aprovação do OpenCode não está mais disponível" }
      }
    },
    shutdown: async () => {
      for (const turn of turns) turn.abort()
      approvals.clear()
      await stopProviderChildren(children)
    },
  }
}
