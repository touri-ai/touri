import type { Bot, HostMethods, Id, Kernel, ToolContext, ToolErr, ToolOk, ToolResult } from "@touri/contracts"
import { withApprovalOutcome } from "../approvals/outcome"
import type { PerformanceStageRunner } from "../kernel/performance"
import { type ComputerGrant, createGrantStore, type GrantStore } from "./grants"
import { type ComputerLock, createComputerLock } from "./lock"
import { type InputTarget, protectedPoint, protectedTarget, sameTarget, terminalTarget } from "./targets"

type Region = { x: number; y: number; width: number; height: number }
type ScreenshotArgs = { maxWidth: number; region: Region | null }
type Mapping = { scale: number; originX: number; originY: number; request: ScreenshotArgs }

export type ComputerAccess = {
  approvalMessage?: string
  grant: ComputerGrant
  bot: Bot
  epoch: number
  terminalApproval?: { target: InputTarget; tool: string; input: unknown }
}

export type ComputerController = {
  execute: (args: {
    ctx: ToolContext
    toolName?: string
    input?: unknown
    operation: (access: ComputerAccess) => Promise<ToolResult>
  }) => Promise<ToolResult>
  screenshot: (args: { access: ComputerAccess; input: ScreenshotArgs }) => Promise<ToolResult>
  click: (args: {
    access: ComputerAccess
    x: number
    y: number
    button: "left" | "right" | "middle"
    clickCount: 1 | 2 | 3
    modifiers: Array<"cmd" | "shift" | "alt" | "ctrl">
  }) => Promise<ToolResult>
  move: (args: { access: ComputerAccess; x: number; y: number }) => Promise<ToolResult>
  type: (args: { access: ComputerAccess; text: string }) => Promise<ToolResult>
  key: (args: { access: ComputerAccess; combo: string }) => Promise<ToolResult>
  scroll: (args: { access: ComputerAccess; x: number; y: number; dx: number; dy: number }) => Promise<ToolResult>
  frontmost: (args: { access: ComputerAccess }) => Promise<ToolResult>
  grant: (args: { botId: Id; threadId: Id; minutes: number }) => ToolResult
  kill: (args: { revokedBy: "user" | "kill-switch" }) => number
  expire: (args?: { at?: number }) => number
  isActive: () => { active: boolean; botId: Id | null }
  handleHostNotification: (method: string) => void
  dispose: () => void
}

type ControllerOptions = {
  runStage?: PerformanceStageRunner
  now?: () => number
  grantWaitMs?: number
  sleep?: (milliseconds: number) => Promise<void>
}

const asError = (errorCode: string, error: string): ToolErr => ({ success: false, errorCode, error })
const okText = (text: string, structured?: unknown): ToolOk => ({
  success: true,
  content: [{ type: "text", text }],
  ...(structured === undefined ? {} : { structured }),
})

const isGranted = (status: Record<string, string>): boolean =>
  status.accessibility === "granted" && status["screen-recording"] === "granted"

const isModifier = (value: unknown): value is "cmd" | "shift" | "alt" | "ctrl" =>
  value === "cmd" || value === "shift" || value === "alt" || value === "ctrl"

const toScreenshotArgs = ({ maxWidth, region }: { maxWidth?: number; region?: Region }): ScreenshotArgs => ({
  maxWidth: maxWidth ?? 1440,
  region: region ?? null,
})

const toGlobal = ({ mapping, x, y }: { mapping: Mapping; x: number; y: number }): { x: number; y: number } => ({
  x: mapping.originX + x / mapping.scale,
  y: mapping.originY + y / mapping.scale,
})

export const createComputerController = (kernel: Kernel, options: ControllerOptions = {}): ComputerController => {
  const now = options.now ?? Date.now
  const grantWaitMs = options.grantWaitMs ?? 120_000
  const sleep =
    options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const grants: GrantStore = createGrantStore({ kernel, now })
  const lock: ComputerLock = createComputerLock()
  const mappings = new Map<Id, Mapping>()
  const waiters = new Set<() => void>()
  const approvalWaiters = new Set<AbortController>()
  let killed = false
  let epoch = 0
  let expiryTimer: ReturnType<typeof setInterval> | null = null

  const publishState = ({
    active,
    botId,
    grantId,
  }: {
    active: boolean
    botId: Id | null
    grantId: Id | null
  }): void => {
    kernel.publish({ type: "computer.state", active, botId, grantId })
  }

  const wakeWaiters = (): void => {
    for (const wake of waiters) wake()
    waiters.clear()
  }

  const botFor = (botId: Id): Bot | null => {
    const store = kernel.services.use("store.api")
    return store?.getBot({ botId }) ?? null
  }

  const setActive = async ({
    active,
    botName,
    generation,
  }: {
    active: boolean
    botName: string | null
    generation?: number
  }) => {
    const params = { active, botName, ...(generation === undefined ? {} : { generation }) }
    return kernel.callHost("computer.setActive", params as HostMethods["computer.setActive"]["params"])
  }

  const waitForGrant = async ({
    botId,
    threadId,
    signal,
  }: {
    botId: Id
    threadId: Id
    signal: AbortSignal
  }): Promise<void> => {
    await new Promise<void>((resolve) => {
      if (grants.active({ botId, threadId, at: now() }) || killed || signal.aborted) {
        resolve()
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const wake = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener("abort", wake)
        waiters.delete(wake)
        resolve()
      }
      timer = setTimeout(wake, grantWaitMs)
      signal.addEventListener("abort", wake, { once: true })
      waiters.add(wake)
    })
  }

  const expiredGrant = (): number => {
    const expire = () => grants.expire({ at: now() })
    const expired = options.runStage ? options.runStage("computer_grant_expiry", expire) : expire()
    const owner = lock.owner()
    if (
      expired > 0 &&
      owner !== null &&
      grants.active({ botId: owner.botId, threadId: owner.threadId, at: now() }) === null
    ) {
      lock.release(owner.grantId)
      mappings.delete(owner.grantId)
      publishState({ active: false, botId: null, grantId: null })
      void setActive({ active: false, botName: null })
    }
    return expired
  }

  expiryTimer = setInterval(() => {
    const expired = expiredGrant()
    if (expired > 0) wakeWaiters()
  }, 1_000)
  expiryTimer.unref?.()

  const authorize = async (ctx: ToolContext, toolName?: string, input?: unknown): Promise<ComputerAccess | ToolErr> => {
    let approvalMessage: string | undefined
    const authorizationEpoch = epoch
    expiredGrant()
    if (ctx.signal.aborted) return asError("DEADLINE_EXCEEDED", "Computer request was canceled")
    const bot = botFor(ctx.botId)
    if (!bot?.computerUse) return asError("COMPUTER_DISABLED", "Computer use is disabled for this bot")
    const machine = bot.machine
    const hostComputerUse = bot.hostComputerUse
    const writes = toolName !== "computer_screenshot" && toolName !== "computer_frontmost"
    if (toolName && writes && bot.access === "read-only")
      return asError("DENIED", "Um bot somente leitura não pode controlar o computador.")
    if (killed) return asError("COMPUTER_KILLED", "Computer use was stopped; grant access again to continue")

    const target = writes ? await kernel.callHost("computer.frontmost", {}) : null
    if (target && !target.success)
      return asError("INPUT_TARGET_UNAVAILABLE", "Não foi possível verificar o aplicativo de destino.")
    if (target?.success && ["computer_type", "computer_key"].includes(toolName ?? "") && protectedTarget(target.value))
      return asError(
        "PROTECTED_INPUT_TARGET",
        "O controle automático não pode operar o touri nem controles de consentimento.",
      )
    const terminal = !!(
      target?.success &&
      terminalTarget(target.value) &&
      ["computer_type", "computer_key"].includes(toolName ?? "")
    )

    const availability = await kernel.callHost("permissions.status", {})
    if (!availability.success && availability.errorCode === "HOST_ERROR")
      return asError("COMPUTER_UNAVAILABLE", availability.error)
    if (!availability.success || !isGranted(availability.value))
      return asError("PERMISSION_MISSING", "Conceda Acessibilidade e Gravação de Tela nos Ajustes do Sistema.")

    const present = toolName ? kernel.services.use("approvals.present") : null
    if (toolName && !present) return asError("COMPUTER_NOT_GRANTED", "A ponte de aprovação está indisponível.")
    if (present && toolName) {
      const approvalController = new AbortController()
      approvalWaiters.add(approvalController)
      const result = await present({
        ctx: { ...ctx, signal: AbortSignal.any([ctx.signal, approvalController.signal]) },
        scope: { source: "computer", tool: toolName },
        toolName,
        input: terminal ? { target: target?.success ? target.value : null, action: input } : (input ?? {}),
        ...(terminal ? { allowStanding: false } : {}),
        isCurrent: () => {
          const latest = botFor(ctx.botId)
          return (
            !killed &&
            epoch === authorizationEpoch &&
            !!latest?.computerUse &&
            latest.machine === machine &&
            latest.hostComputerUse === hostComputerUse &&
            !(writes && latest.access === "read-only")
          )
        },
      }).finally(() => approvalWaiters.delete(approvalController))
      if (killed || authorizationEpoch !== epoch || ctx.signal.aborted)
        return asError("COMPUTER_KILLED", "O controle do computador foi interrompido.")
      if (!result.success) return asError("COMPUTER_NOT_GRANTED", result.error)
      if (result.behavior !== "allow")
        return asError("COMPUTER_NOT_GRANTED", result.message ?? "A ação não foi aprovada.")
      approvalMessage = result.message
      const latestBot = botFor(ctx.botId)
      if (!latestBot?.computerUse || latestBot.machine !== machine || latestBot.hostComputerUse !== hostComputerUse)
        return asError("COMPUTER_DISABLED", "A configuração do controle do computador mudou.")
      if (writes && latestBot.access === "read-only") return asError("DENIED", "O bot está em modo somente leitura.")
      if (!grants.active({ botId: ctx.botId, threadId: ctx.threadId, at: now() }))
        grants.create({ botId: ctx.botId, threadId: ctx.threadId, minutes: 5 })
    }
    let grant = grants.active({ botId: ctx.botId, threadId: ctx.threadId, at: now() })
    if (!grant) {
      kernel.services.use("notify.emit")?.({
        kind: "question",
        botId: ctx.botId,
        threadId: ctx.threadId,
        title: "Computer use approval",
        body: `Allow ${bot.name} to control your Mac for up to 2 minutes? Approve it in the Computer use card.`,
      })
      await waitForGrant({ botId: ctx.botId, threadId: ctx.threadId, signal: ctx.signal })
      if (killed || authorizationEpoch !== epoch)
        return asError("COMPUTER_KILLED", "Computer use was stopped; grant access again to continue")
      grant = grants.active({ botId: ctx.botId, threadId: ctx.threadId, at: now() })
    }
    if (!grant) return asError("COMPUTER_NOT_GRANTED", "Computer use was not granted")

    const permission = await kernel.callHost("permissions.status", {})
    if (killed || authorizationEpoch !== epoch)
      return asError("COMPUTER_KILLED", "Computer use was stopped; grant access again to continue")
    if (ctx.signal.aborted || !botFor(ctx.botId)?.computerUse || (writes && botFor(ctx.botId)?.access === "read-only"))
      return asError("DENIED", "O controle do computador foi cancelado ou desativado.")
    if (!permission.success || !isGranted(permission.value))
      return asError("PERMISSION_MISSING", "Grant Accessibility and Screen Recording access in System Settings")

    if (!lock.acquire({ botId: ctx.botId, threadId: ctx.threadId, grantId: grant.id }))
      return asError("COMPUTER_BUSY", "Another bot currently controls the Mac")
    const currentEpoch = epoch
    const active = await setActive({ active: true, botName: bot.name, generation: currentEpoch })
    if (!active.success) {
      lock.release(grant.id)
      return asError(active.errorCode, active.error)
    }
    if (killed || currentEpoch !== epoch) {
      if (lock.owner()?.grantId === grant.id) {
        lock.release(grant.id)
        await setActive({ active: false, botName: null })
      }
      return asError("COMPUTER_KILLED", "Computer use was stopped; grant access again to continue")
    }
    publishState({ active: true, botId: bot.id, grantId: grant.id })
    return {
      grant,
      bot,
      epoch: currentEpoch,
      ...(approvalMessage ? { approvalMessage } : {}),
      ...(terminal && target?.success && toolName
        ? { terminalApproval: { target: target.value, tool: toolName, input } }
        : {}),
    }
  }

  const execute = async ({
    ctx,
    toolName,
    input,
    operation,
  }: {
    ctx: ToolContext
    toolName?: string
    input?: unknown
    operation: (access: ComputerAccess) => Promise<ToolResult>
  }): Promise<ToolResult> => {
    const access = await authorize(ctx, toolName, input)
    if ("success" in access) return access
    const latest = botFor(ctx.botId)
    if (
      ctx.signal.aborted ||
      !latest?.computerUse ||
      latest.machine !== access.bot.machine ||
      latest.hostComputerUse !== access.bot.hostComputerUse ||
      (toolName !== "computer_screenshot" && toolName !== "computer_frontmost" && latest.access === "read-only")
    )
      return asError("DENIED", "A configuração do controle do computador mudou.")
    const result = await operation(access)
    if (access.epoch !== epoch || killed) return asError("COMPUTER_KILLED", "Computer use was stopped")
    return withApprovalOutcome(result, access.approvalMessage)
  }

  const callScreenshot = async ({
    access,
    input,
  }: {
    access: ComputerAccess
    input: ScreenshotArgs
  }): Promise<ToolResult> => {
    const host =
      input.region === null
        ? await kernel.callHost("computer.screenshot", { maxWidth: input.maxWidth })
        : await kernel.callHost("computer.screenshot", { maxWidth: input.maxWidth, region: input.region })
    if (!host.success) return asError(host.errorCode, kernel.redact(host.error))
    if (access.epoch !== epoch || killed) return asError("COMPUTER_KILLED", "Computer use was stopped")
    const result = host.value
    if (result.scale <= 0) return asError("HOST_ERROR", "Native screenshot returned an invalid scale")
    mappings.set(access.grant.id, {
      scale: result.scale,
      originX: input.region?.x ?? 0,
      originY: input.region?.y ?? 0,
      request: input,
    })
    return {
      success: true,
      content: [{ type: "image", data: result.dataBase64, mimeType: result.mime }],
      structured: { width: result.width, height: result.height, scale: result.scale, displayId: result.displayId },
    }
  }

  const screenshot = async ({
    access,
    input,
  }: {
    access: ComputerAccess
    input: ScreenshotArgs
  }): Promise<ToolResult> => callScreenshot({ access, input })

  const screenshotAfter = async (access: ComputerAccess): Promise<ToolResult> => {
    const mapping = mappings.get(access.grant.id)
    return callScreenshot({ access, input: mapping?.request ?? toScreenshotArgs({}) })
  }

  const guardTarget = async (
    access: ComputerAccess,
    tool: string,
    input: unknown,
    point?: { x: number; y: number },
  ): Promise<ToolErr | null> => {
    if (access.epoch !== epoch || killed) return asError("COMPUTER_KILLED", "O controle foi interrompido.")
    const target = await kernel.callHost("computer.frontmost", {})
    if (!target.success)
      return asError("INPUT_TARGET_UNAVAILABLE", "Não foi possível verificar o aplicativo de destino.")
    if (point ? protectedPoint(target.value, point) : protectedTarget(target.value))
      return asError(
        "PROTECTED_INPUT_TARGET",
        "O controle automático não pode operar o touri nem controles de consentimento.",
      )
    if (terminalTarget(target.value) && ["computer_type", "computer_key"].includes(tool)) {
      const approved = access.terminalApproval
      if (
        !approved ||
        !sameTarget(approved.target, target.value) ||
        approved.tool !== tool ||
        JSON.stringify(approved.input) !== JSON.stringify(input)
      )
        return asError("TERMINAL_CONSENT_REQUIRED", "Esta ação no terminal exige aprovação humana específica.")
    }
    return null
  }

  const click = async ({
    access,
    x,
    y,
    button,
    clickCount,
    modifiers,
  }: {
    access: ComputerAccess
    x: number
    y: number
    button: "left" | "right" | "middle"
    clickCount: 1 | 2 | 3
    modifiers: Array<"cmd" | "shift" | "alt" | "ctrl">
  }): Promise<ToolResult> => {
    const mapping = mappings.get(access.grant.id)
    if (!mapping) return asError("COMPUTER_NO_SCREENSHOT", "Take a computer_screenshot before using coordinates")
    const point = toGlobal({ mapping, x, y })
    const denied = await guardTarget(access, "computer_click", { x, y, button, clickCount, modifiers }, point)
    if (denied) return denied
    const host = await kernel.callHost("computer.click", { x: point.x, y: point.y, button, clickCount, modifiers })
    if (!host.success) return asError(host.errorCode, kernel.redact(host.error))
    await sleep(300)
    return screenshotAfter(access)
  }

  const move = async ({ access, x, y }: { access: ComputerAccess; x: number; y: number }): Promise<ToolResult> => {
    const mapping = mappings.get(access.grant.id)
    if (!mapping) return asError("COMPUTER_NO_SCREENSHOT", "Take a computer_screenshot before using coordinates")
    const point = toGlobal({ mapping, x, y })
    const denied = await guardTarget(access, "computer_move", { x, y }, point)
    if (denied) return denied
    const host = await kernel.callHost("computer.move", point)
    if (!host.success) return asError(host.errorCode, kernel.redact(host.error))
    await sleep(300)
    return screenshotAfter(access)
  }

  const type = async ({ access, text }: { access: ComputerAccess; text: string }): Promise<ToolResult> => {
    const denied = await guardTarget(access, "computer_type", { text })
    if (denied) return denied
    const params = { text, terminalApproval: access.terminalApproval }
    const host = await kernel.callHost("computer.type", params)
    delete access.terminalApproval
    if (!host.success) return asError(host.errorCode, kernel.redact(host.error))
    await sleep(300)
    return screenshotAfter(access)
  }

  const key = async ({ access, combo }: { access: ComputerAccess; combo: string }): Promise<ToolResult> => {
    const denied = await guardTarget(access, "computer_key", { combo })
    if (denied) return denied
    const params = { combo, terminalApproval: access.terminalApproval }
    const host = await kernel.callHost("computer.key", params)
    delete access.terminalApproval
    if (!host.success) return asError(host.errorCode, kernel.redact(host.error))
    await sleep(300)
    return screenshotAfter(access)
  }

  const scroll = async ({
    access,
    x,
    y,
    dx,
    dy,
  }: {
    access: ComputerAccess
    x: number
    y: number
    dx: number
    dy: number
  }): Promise<ToolResult> => {
    const mapping = mappings.get(access.grant.id)
    if (!mapping) return asError("COMPUTER_NO_SCREENSHOT", "Take a computer_screenshot before using coordinates")
    const point = toGlobal({ mapping, x, y })
    const denied = await guardTarget(access, "computer_scroll", { x, y, dx, dy }, point)
    if (denied) return denied
    const host = await kernel.callHost("computer.scroll", { x: point.x, y: point.y, dx, dy })
    if (!host.success) return asError(host.errorCode, kernel.redact(host.error))
    await sleep(300)
    return screenshotAfter(access)
  }

  const frontmost = async (): Promise<ToolResult> => {
    const host = await kernel.callHost("computer.frontmost", {})
    if (!host.success) return asError(host.errorCode, kernel.redact(host.error))
    return okText("Frontmost application returned", host.value)
  }

  const grant = ({ botId, threadId, minutes }: { botId: Id; threadId: Id; minutes: number }): ToolResult => {
    const result = grants.create({ botId, threadId, minutes })
    if (!result.success) return result
    killed = false
    wakeWaiters()
    return { success: true, content: [{ type: "text", text: "Computer use granted" }], structured: result.grant }
  }

  const kill = ({ revokedBy }: { revokedBy: "user" | "kill-switch" }): number => {
    kernel.services.use("computer.input")?.kill()
    kernel.services.use("vm.desktop")?.revokeControl()
    kernel.services.use("vm.stopShells")?.()
    epoch += 1
    killed = revokedBy === "kill-switch"
    for (const controller of approvalWaiters) controller.abort()
    approvalWaiters.clear()
    const revoked = grants.revokeAll({ revokedBy })
    const owner = lock.owner()
    lock.release()
    mappings.clear()
    wakeWaiters()
    if (owner !== null) publishState({ active: false, botId: null, grantId: null })
    void setActive({ active: false, botName: null })
    return revoked
  }

  const isActive = (): { active: boolean; botId: Id | null } => {
    const owner = lock.owner()
    return { active: owner !== null, botId: owner?.botId ?? null }
  }

  const handleHostNotification = (method: string): void => {
    if (method === "computer.killSwitch") kill({ revokedBy: "kill-switch" })
  }

  const dispose = (): void => {
    if (expiryTimer !== null) {
      clearInterval(expiryTimer)
      expiryTimer = null
    }
    kill({ revokedBy: "user" })
  }

  return {
    execute,
    screenshot,
    click,
    move,
    type,
    key,
    scroll,
    frontmost,
    grant,
    kill,
    expire: expiredGrant,
    isActive,
    handleHostNotification,
    dispose,
  }
}

export { isModifier, toGlobal, toScreenshotArgs }
