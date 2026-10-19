import type { Database } from "bun:sqlite"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { stripVTControlCharacters } from "node:util"
import { type Bot, getHostNoun, type Kernel, type ProviderLoginFlow, type RouteModule } from "@touri/contracts"
import { withDeadline } from "../kernel/policy"
import { providerProfileEnv } from "../kernel/provider-profiles"
import { buildChildEnv } from "../kernel/shell-env"
import { getHostIdentity } from "../platform/host"
import { killProviderLoginPty, spawnProviderLoginPty } from "../platform/provider-login"
import { providerProfileStatus } from "../runtime/provider-profiles"
import { resolveProviderExecutable } from "../runtime/resolveProviderExecutable"
import {
  loginTarget,
  NATIVE_VAULT_GUIDANCE,
  ProviderLoginError,
  providerLoginAccount,
  providerLoginSourceKey,
  readHostLoginFile,
  readVault,
  redactProviderLogin,
  SERVER_VAULT_GUIDANCE,
  storedProviderLoginSource,
  validLogin,
} from "./provider-login"

type Target = Pick<Bot, "id" | "provider">
type Child = Extract<ReturnType<Kernel["spawnTree"]>, { success: true }>

type Session = {
  target: Target
  view: ProviderLoginFlow
  child?: Child
  secret?: string
  host?: boolean
  timer?: ReturnType<typeof setTimeout>
  directory?: string
  cleanup?: Promise<void>
  pastePrompt?: number
  codeReady?: boolean
  retryCode?: boolean
  codeBusy?: boolean
  onCodePrompt?: () => void
}
export type LoginInvocation = {
  provider: Bot["provider"]
  cmd: string
  args: string[]
  env: Record<string, string>
  cwd: string
}
const isDraft = (id: string) => /^draft-[0-9a-f-]{36}$/.test(id)
const key = (target: Target) => `${target.id}:${target.provider}`
const verificationUrl = (provider: Bot["provider"], output: string) => {
  let latest: string | undefined
  // OSC 8 retains full URLs even when the visible terminal link wraps.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC 8 uses ESC and BEL delimiters.
  const links = [...output.matchAll(/\u001b\]8;[^;\u0007\u001b]*;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g)].map(
    (match) => match[1] ?? "",
  )
  const text = stripVTControlCharacters(output).replace(/\r/g, "")
  // Wait for a delimiter: a read can end halfway through a URL.
  const printed = [...text.matchAll(/https:\/\/[^\s<>"']+(?=[\s<>"'])/g)].map((match) => match[0])
  for (const candidate of [...printed, ...links]) {
    try {
      const url = new URL(candidate)
      if (url.protocol !== "https:" || url.username || url.password || url.port) continue
      if (
        [...url.searchParams.keys()].some((key) => /^(?:access_token|refresh_token|id_token|api_key|token)$/i.test(key))
      )
        continue
      const allowed =
        provider === "claude"
          ? url.origin === "https://claude.com" && url.pathname === "/cai/oauth/authorize"
          : provider === "codex"
            ? ["auth.openai.com", "chatgpt.com"].includes(url.hostname) &&
              ["/codex/device", "/device", "/activate", "/oauth/device"].includes(url.pathname)
            : // OpenCode can delegate login to the provider chosen in its CLI menu.
              /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(url.hostname) &&
              !/\.(?:local|internal|localhost)$/i.test(url.hostname)
      if (allowed) latest = url.href
    } catch {}
  }
  return latest
}
const claudeToken = (output: string) => {
  const text = stripVTControlCharacters(output).replace(/\r/g, "")
  const lines = text.split("\n")
  for (let index = 0; index < lines.length; index++) {
    let token = lines[index]?.match(/sk-ant-oat01-[\w-]+/)?.[0]
    if (!token) continue
    // Ink can wrap the printed token to the PTY width. Only join credential-shaped continuation lines.
    while (/^\s*[\w-]{20,}\s*$/.test(lines[index + 1] ?? "")) token += lines[++index]?.trim()
    return token
  }
  return ""
}

// Kept here for callers that used the login flow validator.
export { validLogin } from "./provider-login"

export const createProviderLoginFlow = ({
  kernel,
  hostHome = homedir(),
  platform = process.platform,
  headless = process.env.TOURI_HEADLESS === "1",
  timeoutMs = 10 * 60_000,
  invoke,
  profileStatus = providerProfileStatus,
}: {
  kernel: Kernel
  hostHome?: string
  platform?: NodeJS.Platform
  headless?: boolean
  timeoutMs?: number
  invoke?: (input: LoginInvocation) => ReturnType<Kernel["spawnTree"]>
  profileStatus?: typeof providerProfileStatus
}) => {
  const hostContext = getHostIdentity(platform, headless)
  const host = hostContext.hostKind
  const hostUnavailable = `Login deste ${getHostNoun(host)} indisponível.`
  const sessions = new Map<string, Session>()
  const starts = new Map<string, Promise<ProviderLoginFlow>>()
  const writes = new Map<string, Promise<void>>()
  const redact = (value: string) => {
    redactProviderLogin(kernel, value)
  }
  const hostAvailable = (provider: Bot["provider"]) => {
    try {
      const value = readHostLoginFile(hostHome, loginTarget(provider))
      redact(value)
      return validLogin(provider, value, true)
    } catch {
      return false
    }
  }
  const selectSource = (target: Target, source: "vault" | "host-file") =>
    (kernel.db as Database)
      .query(
        "INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
      )
      .run(providerLoginSourceKey(target), JSON.stringify(source), Date.now())
  const enableLogin = (target: Target) => {
    const bot = kernel.services.use("store.api")?.getBot({ botId: target.id })
    if (bot?.provider === target.provider && bot.machine === "vm") {
      ;(kernel.db as Database).query("UPDATE bots SET vm_provider_login=1 WHERE id=?").run(bot.id)
      const updated = kernel.services.use("store.api")?.getBot({ botId: bot.id })
      if (updated) kernel.publish({ type: "bot.updated", bot: updated })
    }
  }
  const save = async (session: Session, value: string) => {
    redact(value)
    if (isDraft(session.target.id)) {
      session.secret = value
      clearTimeout(session.timer)
      session.timer = setTimeout(() => {
        cancel(session.target)
        sessions.delete(key(session.target))
      }, timeoutMs)
      session.timer.unref()
      return
    }
    const accountKey = key(session.target)
    const pending = (writes.get(accountKey) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const cancelled = () => session.view.state === "cancelled" || session.view.state === "error"
        if (cancelled()) throw new Error("cancelled")
        const result = await kernel.callHost("keychain.set", {
          account: providerLoginAccount(session.target.id, session.target.provider),
          value,
        })
        if (!result.success) throw new Error("vault")
        if (cancelled()) {
          await kernel.callHost("keychain.delete", {
            account: providerLoginAccount(session.target.id, session.target.provider),
          })
          throw new Error("cancelled")
        }
        selectSource(session.target, "vault")
        enableLogin(session.target)
      })
    writes.set(accountKey, pending)
    await withDeadline({
      operation: () => pending,
      timeoutMs,
    })
  }
  const clean = (session: Session): Promise<void> => {
    clearTimeout(session.timer)
    session.onCodePrompt?.()
    const cleanup = session.directory
      ? rm(session.directory, { recursive: true, force: true }).catch(() => {})
      : Promise.resolve()
    session.cleanup = cleanup
    delete session.directory
    delete session.child
    return cleanup
  }
  /** The login home is removed again once the CLI tree is dead, so a late write cannot leave a credential behind. */
  const stopLoginChild = (session: Session): void => {
    const { child, directory } = session
    if (!child) return
    void killProviderLoginPty(child).finally(() => {
      if (directory) void rm(directory, { recursive: true, force: true }).catch(() => {})
    })
  }
  const cancel = (target: Target, state: "cancelled" | "error" = "cancelled") => {
    const session = sessions.get(key(target))
    if (session) {
      const child = session.child
      stopLoginChild(session)
      session.view = {
        provider: target.provider,
        state,
        ...hostContext,
        ...(state === "error" ? { retryable: true, message: "O login expirou. Tente novamente." } : {}),
      }
      delete session.secret
      clean(session)
      if (child) void child.exited.finally(() => clean(session)).catch(() => {})
    }
    return session?.view ?? { provider: target.provider, state }
  }
  /** A bot with a provider profile signs in through that profile, never the vault or the host login. */
  const profileLogin = async (target: Target): Promise<ProviderLoginFlow | null> => {
    if (isDraft(target.id)) return null
    const bot = kernel.services.use("store.api")?.getBot({ botId: target.id })
    const profile = bot?.providerProfile
    if (!bot || !profile || bot.provider !== target.provider) return null
    if (!Object.keys(providerProfileEnv({ appData: kernel.paths.appData, bot })).length) return null
    if (bot.provider !== "claude" && bot.provider !== "codex") return null
    const { loggedIn } = await profileStatus({
      appData: kernel.paths.appData,
      profile,
      provider: bot.provider,
      env: buildChildEnv({ base: await kernel.shellEnv() }),
    })
    return loggedIn
      ? { provider: target.provider, state: "ready", ...hostContext }
      : {
          provider: target.provider,
          state: "error",
          ...hostContext,
          message: `O perfil ${profile} não está logado. No servidor, rode: touri profile login ${profile}`,
        }
  }
  const status = async (target: Target): Promise<ProviderLoginFlow> => {
    const profile = await profileLogin(target)
    if (profile) return profile
    const current = sessions.get(key(target))
    if (current?.cleanup) await current.cleanup
    // A cancelled browser attempt must not mask an existing or repaired saved login.
    if (current && (current.view.state === "waiting" || isDraft(target.id))) return { ...current.view }
    const source = isDraft(target.id) ? null : storedProviderLoginSource(kernel, target)
    if (!source && hostAvailable(target.provider))
      return { provider: target.provider, state: "host-available", ...hostContext }
    if (source !== "host-file" && !isDraft(target.id)) {
      let value: string | null
      try {
        value = await readVault(kernel, target, loginTarget(target.provider), {})
      } catch (error) {
        if (host !== "mac" && error instanceof ProviderLoginError)
          return {
            provider: target.provider,
            state: "error",
            ...hostContext,
            message: headless ? SERVER_VAULT_GUIDANCE : NATIVE_VAULT_GUIDANCE,
          }
        if (
          host === "mac" &&
          error instanceof ProviderLoginError &&
          (error.reason === "vault-locked" || error.reason === "transport")
        )
          return { provider: target.provider, state: "vault-locked" }
        throw error
      }
      if (value) {
        redact(value)
        if (validLogin(target.provider, value)) {
          if (!source) selectSource(target, "vault")
          return { provider: target.provider, state: "ready" }
        }
      }
    }
    if (hostAvailable(target.provider))
      return source === "host-file"
        ? { provider: target.provider, state: "ready" }
        : { provider: target.provider, state: "host-available", ...hostContext }
    return current?.view.state === "cancelled" || current?.view.state === "error"
      ? { ...current.view }
      : { provider: target.provider, state: "idle" }
  }
  const start = async (target: Target): Promise<ProviderLoginFlow> => {
    const existing = sessions.get(key(target))
    if (existing?.view.state === "waiting") return { ...existing.view }
    const session: Session = { target, view: { provider: target.provider, state: "waiting", ...hostContext } }
    sessions.set(key(target), session)
    session.timer = setTimeout(() => cancel(session.target, "error"), timeoutMs)
    session.timer.unref()
    void (async () => {
      let output = ""
      try {
        const base = buildChildEnv({ base: await kernel.shellEnv() })
        if (session.view.state !== "waiting") return
        const directory = await mkdtemp(join(kernel.paths.runDir, "provider-login-"))
        await chmod(directory, 0o700)
        session.directory = directory
        for (const name of [".codex", ".claude", ".local/share/opencode"])
          await mkdir(join(directory, name), { recursive: true, mode: 0o700 })
        const env: Record<string, string> = {
          ...base,
          HOME: directory,
          CODEX_HOME: join(directory, ".codex"),
          CLAUDE_CONFIG_DIR: join(directory, ".claude"),
          XDG_DATA_HOME: join(directory, ".local/share"),
          COLUMNS: "240",
        }
        for (const name of [
          "ANTHROPIC_API_KEY",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "OPENAI_API_KEY",
          "CODEX_API_KEY",
          "NODE_OPTIONS",
          "BUN_OPTIONS",
        ])
          delete (env as Record<string, string>)[name]
        if (host !== "mac") {
          env.BROWSER = "echo"
          delete env.DISPLAY
          delete env.WAYLAND_DISPLAY
        }
        const command = target.provider
        const args =
          command === "claude"
            ? ["setup-token"]
            : command === "codex"
              ? ["-c", 'cli_auth_credentials_store="file"', "login", "--device-auth"]
              : ["auth", "login"]
        let spawned: ReturnType<Kernel["spawnTree"]>
        if (invoke) spawned = invoke({ provider: command, cmd: command, args, env, cwd: directory })
        else {
          const resolved = await resolveProviderExecutable({
            kernel,
            command: process.env[`TOURI_${command.toUpperCase()}_BIN`] ?? command,
            env: { ...base, PATH: [base.PATH, join(hostHome, ".opencode/bin")].filter(Boolean).join(delimiter) },
          })
          if (!resolved.success) throw new Error("cli")
          if (session.view.state !== "waiting") return
          env.PATH = resolved.env.PATH ?? ""
          spawned = spawnProviderLoginPty({
            command: resolved.path,
            args,
            cwd: directory,
            env,
            spawn: kernel.spawnTree,
          })
        }
        if (!spawned.success) throw new Error("cli")
        session.child = spawned
        const read = async (stream: ReadableStream<Uint8Array>) => {
          const decoder = new TextDecoder()
          const reader = stream.getReader()
          try {
            while (true) {
              const { done, value: chunk } = await reader.read()
              if (done) break
              output += decoder.decode(chunk, { stream: true })
              if (output.length > 128_000) throw new Error("output")
              if (session.view.state !== "waiting") continue
              const url = verificationUrl(command, output)
              if (url) {
                kernel.addRedactionValue(url)
                session.view.verificationUrl = url
                if (command === "opencode") delete session.view.prompt
              }
              const text = stripVTControlCharacters(output).replace(/\r/g, "")
              if (command === "claude" || command === "opencode") {
                const prompt =
                  command === "claude"
                    ? text.lastIndexOf("Paste code here")
                    : ([...text.matchAll(/(?:^|\n)[│◇◆\s]*(?:paste|enter)(?: the)? (?:authorization )?code/gi)].at(-1)
                        ?.index ?? -1)
                if (prompt > (session.pastePrompt ?? -1)) {
                  session.pastePrompt = prompt
                  session.codeReady = true
                  session.retryCode = false
                  session.view.needsCode = true
                  delete session.view.codeError
                  session.onCodePrompt?.()
                }
                if (text.lastIndexOf("OAuth error: Invalid code") > prompt) {
                  session.view.codeError =
                    "Código inválido. Copie o código completo exibido no navegador e tente novamente."
                  if (text.lastIndexOf("Press Enter to retry") > prompt) session.retryCode = true
                }
              }
              if (command === "opencode") {
                const prompts = [...text.matchAll(/Select (provider|login method)/gi)]
                const prompt = prompts.at(-1)
                if (prompt) {
                  const tail = text.slice(prompt.index)
                  const choice = [...tail.matchAll(/[●◆]\s+([A-Za-z][A-Za-z0-9 .+()/-]{1,90})/g)].at(-1)?.[1]?.trim()
                  if (choice)
                    session.view.prompt = {
                      kind: prompt[1]?.toLowerCase() === "provider" ? "provider" : "method",
                      choice,
                    }
                }
                if (/https:\/\//.test(text.slice(prompts.at(-1)?.index ?? 0))) delete session.view.prompt
              }
              for (const token of text.matchAll(/sk-ant-oat01-[\w-]+/g)) redact(token[0])
              const code =
                command !== "claude" &&
                ([
                  ...text.matchAll(/(?:code|código)(?:\s+is)?\s*[:\n]?\s*([A-Z0-9]{4,5}(?:-[A-Z0-9]{4,5}){1,2})\b/gi),
                ].at(-1)?.[1] ??
                  text.match(/(?:^|\n)\s*([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\s*(?:\n|$)/)?.[1])
              if (code) {
                kernel.addRedactionValue(code)
                session.view.deviceCode = code
              }
            }
          } finally {
            reader.releaseLock()
          }
        }
        const [, , exit] = await Promise.all([read(spawned.stdout), read(spawned.stderr), spawned.exited])
        if (session.view.state !== "waiting") return
        if (exit.code !== 0) throw new Error("cli")
        const value = command === "claude" ? claudeToken(output) : readHostLoginFile(directory, loginTarget(command))
        if (!validLogin(command, value)) throw new Error("credential")
        await save(session, value)
        if (session.view.state !== "waiting") return
        session.view = { provider: command, state: "ready" }
      } catch {
        if (session.view.state === "waiting") {
          stopLoginChild(session)
          session.view = {
            provider: target.provider,
            state: "error",
            ...hostContext,
            retryable: true,
            message: "Não foi possível concluir o login. Tente novamente ou cole o token manualmente.",
          }
        }
      } finally {
        output = ""
        await clean(session)
        if (isDraft(session.target.id) && session.secret) {
          session.timer = setTimeout(() => {
            delete session.secret
            sessions.delete(key(session.target))
          }, timeoutMs)
          session.timer.unref()
        }
      }
    })()
    return { ...session.view }
  }
  const action = async (
    target: Target,
    input: { action: string; value?: string; draftId?: string; input?: string },
  ): Promise<ProviderLoginFlow> => {
    if (input.action !== "cancel") {
      const profile = await profileLogin(target)
      if (profile) return profile
    }
    if (input.action === "cancel") {
      const view = cancel(target)
      await sessions.get(key(target))?.cleanup
      return view
    }
    if (input.action === "code") {
      const value = typeof input.value === "string" ? input.value.trim() : ""
      if (!value || value.length > 2000 || /[\r\n\u2028\u2029]/.test(input.value ?? ""))
        throw new Error("Código inválido.")
      const session = sessions.get(key(target))
      if (
        (target.provider !== "claude" && target.provider !== "opencode") ||
        session?.view.state !== "waiting" ||
        !session.child ||
        !session.view.needsCode ||
        session.codeBusy ||
        (!session.codeReady && !session.retryCode)
      )
        throw new Error("Envio de código indisponível.")
      redact(value)
      const writer = session.child.stdin.getWriter()
      session.codeBusy = true
      try {
        if (session.retryCode) {
          const prompt = new Promise<void>((resolve) => {
            session.onCodePrompt = resolve
          })
          await writer.write(new TextEncoder().encode("\r"))
          await withDeadline({ operation: () => prompt, timeoutMs: Math.min(timeoutMs, 5000) })
        }
        if (session.view.state !== "waiting" || !session.child || !session.codeReady)
          throw new Error("Envio de código indisponível.")
        session.codeReady = false
        delete session.view.codeError
        await writer.write(new TextEncoder().encode(`${value}\r`))
      } finally {
        writer.releaseLock()
        session.codeBusy = false
        delete session.onCodePrompt
      }
      return { ...session.view }
    }
    if (input.action === "input") {
      const session = sessions.get(key(target))
      const bytes =
        input.input === "up" ? "\u001b[A" : input.input === "down" ? "\u001b[B" : input.input === "enter" ? "\r" : null
      if (target.provider !== "opencode" || !bytes || !session?.child || !session.view.prompt)
        throw new Error("Seleção indisponível.")
      if (
        host !== "mac" &&
        input.input === "enter" &&
        session.view.prompt?.kind === "method" &&
        /\bbrowser\b/i.test(session.view.prompt.choice) &&
        !/\bheadless\b/i.test(session.view.prompt.choice)
      )
        throw new Error("Escolha um método com código para entrar por este aparelho.")
      const writer = session.child.stdin.getWriter()
      try {
        await writer.write(new TextEncoder().encode(bytes))
      } finally {
        writer.releaseLock()
      }
      return { ...session.view }
    }
    if (input.action === "start") {
      if (
        !sessions.has(key(target)) &&
        [...sessions.values()].filter((session) => session.view.state === "waiting").length >= 8
      )
        throw new Error("Há muitos logins em andamento.")
      const pending = starts.get(key(target))
      if (pending) return pending
      const operation = start(target).finally(() => starts.delete(key(target)))
      starts.set(key(target), operation)
      return operation
    }
    if (input.action === "use-host") {
      if (!hostAvailable(target.provider)) throw new Error(hostUnavailable)
      cancel(target)
      if (!isDraft(target.id)) selectSource(target, "host-file")
      if (!isDraft(target.id)) enableLogin(target)
      const session: Session = { target, host: true, view: { provider: target.provider, state: "ready" } }
      sessions.set(key(target), session)
      return session.view
    }
    if (input.action === "paste") {
      const value = input.value?.trim() ?? ""
      if (value.length > 20_000 || !validLogin(target.provider, value)) throw new Error("Login inválido.")
      cancel(target)
      const session: Session = { target, view: { provider: target.provider, state: "waiting", ...hostContext } }
      sessions.set(key(target), session)
      try {
        await save(session, value)
      } catch (error) {
        session.view = { provider: target.provider, state: "error" }
        throw error
      }
      if (session.view.state !== "waiting") return session.view
      session.view = { provider: target.provider, state: "ready" }
      return session.view
    }
    if (input.action === "adopt" && !isDraft(target.id) && input.draftId && isDraft(input.draftId)) {
      const draft = sessions.get(key({ id: input.draftId, provider: target.provider }))
      if (!draft && (await status(target)).state === "ready") return { provider: target.provider, state: "ready" }
      if (draft?.view.state !== "ready") throw new Error("Conclua o login antes de criar o bot.")
      if (draft.host) {
        if (!hostAvailable(target.provider)) throw new Error(hostUnavailable)
        selectSource(target, "host-file")
        enableLogin(target)
      } else if (draft.secret) await save({ ...draft, target }, draft.secret)
      else throw new Error("Login expirado. Conecte novamente.")
      clearTimeout(draft.timer)
      delete draft.secret
      sessions.delete(key(draft.target))
      return { provider: target.provider, state: "ready" }
    }
    throw new Error("Ação de login inválida.")
  }
  const routes: RouteModule["routes"] = (["GET", "POST"] as const).map((method) => ({
    method,
    path: "/bots/:id/provider-login/flow",
    handler: async ({ params, body, query }) => {
      const id = params.id ?? ""
      const bot = kernel.services.use("store.api")?.getBot({ botId: id })
      if (!bot && !isDraft(id)) return { status: 404, json: { error: "Bot não encontrado" } }
      if (bot?.machine === "cloud") return { status: 403, json: { errorCode: "TOURI-E9014" } }
      const input = (method === "GET" ? query : body) as {
        provider?: unknown
        action?: string
        value?: string
        draftId?: string
        input?: string
      }
      if (!["claude", "codex", "opencode"].includes(String(input?.provider)))
        return { status: 400, json: { error: "Provedor inválido" } }
      const target = { id, provider: input.provider as Bot["provider"] }
      try {
        if (method === "POST" && input.action === "cancel")
          return { status: 200, json: { ...cancel(target), ...hostContext } }
        // Readiness must not invoke the provider or spend a model response. Login and
        // installation are independent: credentials can outlive an uninstalled CLI.
        const base = buildChildEnv({ base: await kernel.shellEnv() })
        const command = process.env[`TOURI_${target.provider.toUpperCase()}_BIN`] ?? target.provider
        const resolved = await resolveProviderExecutable({
          kernel,
          command,
          env: { ...base, PATH: [base.PATH, join(hostHome, ".opencode/bin")].filter(Boolean).join(":") },
        })
        const view =
          method === "GET" || (!resolved.success && ["start", "use-host", "adopt"].includes(input.action ?? ""))
            ? await status(target)
            : await action(target, { ...input, action: input.action ?? "" })
        return {
          status: 200,
          json: { ...view, ...hostContext, executable: resolved.success ? "available" : "missing" },
        }
      } catch {
        return { status: 503, json: { error: "Não foi possível configurar o login. Tente novamente." } }
      }
    },
  }))
  const unsubscribe = kernel.subscribe(({ event }) => {
    for (const session of sessions.values()) {
      if (
        (event.type === "bot.deleted" && event.botId === session.target.id) ||
        (event.type === "bot.updated" &&
          event.bot.id === session.target.id &&
          (event.bot.machine === "cloud" || event.bot.provider !== session.target.provider))
      ) {
        cancel(session.target)
        sessions.delete(key(session.target))
      }
    }
  })
  return {
    routes,
    status,
    action,
    dispose: () => {
      unsubscribe()
      for (const session of sessions.values()) cancel(session.target)
      sessions.clear()
    },
  }
}
