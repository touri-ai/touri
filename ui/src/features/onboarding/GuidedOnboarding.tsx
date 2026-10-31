import type { Bot, BotGroup, HostKind, Thread } from "@touri/contracts"
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react"
import { createApiClient, type Endpoint, resolveSidecarEndpoint, type TauriInvoke, type UiApi } from "../../api/client"
import { Button } from "../../components/Button"
import { t } from "../../i18n"
import { setStorageScope } from "../../storageScope"
import { useHost } from "../../useHost"
import { ServerModeProvider } from "../server/serverMode"
import { AgentImport, ManualImport } from "./AgentImport"
import { AgentFields, ComputerFields, ContextFields, TeamFields, WorkspaceFields } from "./GuideFields"
import { GuideLayout } from "./GuideLayout"
import {
  type ComputerDraft,
  createGuideChannels,
  type GuideStep,
  getImportedIdentity,
  getImportedNames,
  getIsEmptyOwnerWorkspace,
  getIsGuideBotReady,
  getStage,
  getWebsite,
  guideBot,
  saveGuideDestination,
  topicOptions,
  type WorkspaceDraft,
} from "./guide"
import { useAgentImport } from "./useAgentImport"
import "./guide.css"

export const GuidedOnboarding = ({
  invoke,
  api: providedApi,
  onBack,
  onComplete,
  checkExistingWorkspace = false,
}: {
  checkExistingWorkspace?: boolean
  invoke: TauriInvoke
  api?: UiApi
  onBack: () => void
  onComplete: () => Promise<void>
}) => {
  const [api, setApi] = useState<UiApi | null>(providedApi ?? null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const complete = useRef(onComplete)
  complete.current = onComplete
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt retries endpoint discovery.
  useEffect(() => {
    if (providedApi) return
    const controller = new AbortController()
    void getGuideEndpoint(invoke)
      .then(async (endpoint) => {
        if (controller.signal.aborted) return
        setStorageScope(endpoint.scope ?? null)
        const client = createApiClient({ endpoint, resolveEndpoint: () => getGuideEndpoint(invoke) })
        const shouldSetUp = !checkExistingWorkspace || (await getIsEmptyOwnerWorkspace(client, controller.signal))
        if (controller.signal.aborted) return
        if (!shouldSetUp) {
          await complete.current()
          return
        }
        setApi(client)
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
    return () => controller.abort()
  }, [invoke, providedApi, attempt, checkExistingWorkspace])
  if (api)
    return (
      <ServerModeProvider invoke={invoke} fallback={<p role="status">{t("ob.connecting")}</p>}>
        <Guide api={api} invoke={invoke} onBack={onBack} onComplete={onComplete} />
      </ServerModeProvider>
    )
  return (
    <main className="setup-screen">
      <section className="setup-card">
        <p role={failed ? "alert" : "status"}>{t(failed ? "ob.connectionError" : "ob.connecting")}</p>
        {failed && (
          <Button
            onClick={() => {
              setFailed(false)
              setAttempt((value) => value + 1)
            }}
          >
            {t("ob.retry")}
          </Button>
        )}
        <Button onClick={onBack}>{t("Back")}</Button>
      </section>
    </main>
  )
}
const Guide = ({
  api,
  invoke,
  onBack,
  onComplete,
}: {
  api: UiApi
  invoke: TauriInvoke
  onBack: () => void
  onComplete: () => Promise<void>
}) => {
  const [step, setStep] = useState<GuideStep>("workspace")
  const [draft, setDraft] = useState<WorkspaceDraft>({
    name: "",
    color: "var(--brand)",
    context: "",
    website: "",
    topics: [],
  })
  const [computer, setComputer] = useState<ComputerDraft>({
    browserEnabled: false,
    access: "read-only",
    approvals: "on-request",
    machine: "local",
    machineIdleMinutes: 10,
    vmProviderLogin: false,
    hostComputerUse: false,
  })
  const [bots, setBots] = useState<Bot[]>([])
  const [groups, setGroups] = useState<BotGroup[]>([])
  const [hasTeam, setHasTeam] = useState(false)
  const [invited, setInvited] = useState(false)
  const [manual, setManual] = useState("")
  const [task, setTask] = useState("")
  const [target, setTarget] = useState("")
  const [thread, setThread] = useState<Thread | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const operation = useRef(false)
  const createdGuideId = useRef<string | null>(null)
  const pendingMessage = useRef<{ threadId: string; text: string; nonce: string } | null>(null)
  const imports = useAgentImport(api)
  const host = useHost(api)
  const computerName = getComputerLabel(host)
  const refreshBots = useCallback(async () => {
    const result = await api.request("GET /bots", {})
    const importedIds = imports.results.flatMap((result) => result.bots.map((bot) => bot.botId))
    const selected = result.bots.filter((bot) => bot.name === "touri" || importedIds.includes(bot.id))
    const identified = selected.map((bot) => {
      const draftBot = bots.find((item) => item.id === bot.id)
      const account = draftBot ? { provider: draftBot.provider, model: draftBot.model } : {}
      return { ...bot, ...account, ...getImportedIdentity(bot.id, imports.results) }
    })
    setBots(identified)
    return identified
  }, [api, imports.results, bots])
  useEffect(() => {
    const controller = new AbortController()
    void api
      .request("GET /invites", {}, {}, { signal: controller.signal })
      .then(() => {
        if (!controller.signal.aborted) setHasTeam(true)
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [api])
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus only on screen changes.
  useEffect(() => {
    // Let scrolling paint before focus so both operations can reuse the committed layout.
    const activeElement = document.activeElement
    let focusFrame = 0
    const frame = requestAnimationFrame(() => {
      heading.current?.closest(".ob-screen")?.scrollTo?.({ top: 0, behavior: "instant" })
      focusFrame = requestAnimationFrame(() => {
        if (document.activeElement !== activeElement) return
        heading.current?.focus({ preventScroll: true })
      })
    })
    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(focusFrame)
    }
  }, [step])
  const go = (next: GuideStep) => {
    setError(null)
    setNotice(null)
    setStep(next)
  }
  const run = async (action: () => Promise<void>) => {
    if (operation.current) return
    operation.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch {
      setError(t("ob.saveError"))
    } finally {
      operation.current = false
      setBusy(false)
    }
  }
  const prepareAgents = async () => {
    const existing = await refreshBots()
    if (existing.some((bot) => bot.name === "touri")) {
      go("agents")
      return
    }
    const { bot } = await api.request("POST /bots", {
      name: "touri",
      provider: "claude",
      color: guideBot.color,
      avatarSeed: guideBot.avatarSeed,
      avatarShape: guideBot.avatarShape,
      description: draft.name.trim(),
      instructions: t("ob.guideInstructions", { name: draft.name.trim(), context: draft.context }),
      access: computer.access,
      approvals: computer.approvals,
      browserEnabled: computer.browserEnabled,
      machine: computer.machine,
      machineIdleMinutes: computer.machineIdleMinutes,
      vmProviderLogin: computer.vmProviderLogin,
      hostComputerUse: computer.hostComputerUse,
    })
    createdGuideId.current = bot.id
    setBots([...existing, bot])
    setTarget(bot.id)
    go("agents")
  }
  const saveAgents = async () => {
    if (!bots.length) throw new Error("NO_AGENTS")
    const updated = await Promise.all(
      bots.map(
        async (bot) =>
          (
            await api.request(
              "PATCH /bots/:id",
              {
                ...getImportedIdentity(bot.id, imports.results),
                provider: bot.provider,
                model: bot.model,
                ...(bot.id === createdGuideId.current
                  ? {
                      description: draft.name.trim(),
                      color: guideBot.color,
                      instructions: t("ob.guideInstructions", { name: draft.name.trim(), context: draft.context }),
                    }
                  : {}),
                access: computer.access,
                approvals: computer.approvals,
                browserEnabled: computer.browserEnabled,
                machine: computer.machine,
                machineIdleMinutes: computer.machineIdleMinutes,
                vmProviderLogin: computer.vmProviderLogin,
                hostComputerUse: computer.hostComputerUse,
              },
              { id: bot.id },
            )
          ).bot,
      ),
    )
    setBots(updated)
    setGroups(
      await createGuideChannels(
        api,
        draft,
        updated.map((bot) => bot.id),
      ),
    )
    if (!target) setTarget(updated[0]?.id ?? "")
    go(hasTeam ? "team" : "task")
  }
  const undoImport = async (importId: string) => {
    const result = imports.results.find((item) => item.importId === importId)
    if (!result) return
    const names = getImportedNames(imports, importId)
    if (!(await imports.undo(importId))) return

    const removed = result.bots.map((bot) => bot.botId)
    setBots((previous) => previous.filter((bot) => !removed.includes(bot.id)))
    if (removed.includes(target)) setTarget("")
    go("sources")
    setNotice(t("ob.importUndone", { names }))
  }
  const sendFirstTask = async () => {
    const general = groups.find((group) => group.name === "geral")
    const bot = bots.find((bot) => bot.id === target) ?? bots[0]
    if (!general || !bot || !task.trim()) return
    if (!(await getIsGuideBotReady(api, bot))) {
      go("agents")
      setError(t("ob.accountNotReady", { name: bot.name }))
      return
    }
    const threads = thread ? [thread] : (await api.request("GET /groups/:id/threads", {}, { id: general.id })).threads
    const destination =
      threads[0] ??
      (await api.request("POST /groups/:id/threads", { title: t("ob.firstTask") }, { id: general.id })).thread
    const website = draft.website ? t("ob.websiteTask", { website: draft.website }) : ""
    const context = t("ob.ownerContext", { name: draft.name.trim(), context: draft.context })
    const text = `@${bot.name} ${task.trim()}\n\n${context}${website ? `\n\n${website}` : ""}`
    const previous = pendingMessage.current
    const clientNonce =
      previous?.threadId === destination.id && previous.text === text ? previous.nonce : crypto.randomUUID()
    pendingMessage.current = { threadId: destination.id, text, nonce: clientNonce }
    setThread(destination)
    await api.request(
      "POST /threads/:id/messages",
      { threadId: destination.id, parentId: null, text, attachmentIds: [], clientNonce },
      { id: destination.id },
    )
    saveGuideDestination(destination.id)
    go("ready")
    await onComplete()
  }
  const next = async () => {
    if (busy) return
    if (step === "workspace") {
      if (draft.name.trim()) go("context")
      return
    }
    if (step === "context") {
      try {
        if (draft.website) setDraft({ ...draft, website: getWebsite(draft.website) })
      } catch {
        setError(t("ob.websiteError"))
        return
      }
      go("sources")
      return
    }
    if (step === "sources" || step === "manual") {
      if (await imports.previewSources(step === "manual" ? manual : undefined)) {
        setManual("")
        go("review")
      }
      return
    }
    if (step === "review") {
      go("importing")
      void imports.apply()
      return
    }
    if (step === "importing") {
      go("computer")
      return
    }
    if (step === "computer") {
      await run(prepareAgents)
      return
    }
    if (step === "agents") {
      await run(saveAgents)
      return
    }
    if (step === "team") {
      go("task")
      return
    }
    if (step === "task") {
      await run(sendFirstTask)
      return
    }
    await run(onComplete)
  }
  const back = () => {
    if (busy || imports.busy || step === "ready") return
    if (step === "workspace") {
      onBack()
      return
    }
    go(getPrevious(step, hasTeam, imports.previews.length > 0))
  }
  const skip = () => {
    if (step === "context") setDraft((previous) => ({ ...previous, context: "", website: "", topics: [] }))
    if (["sources", "manual", "review"].includes(step)) {
      imports.clearPreview()
      setManual("")
    }
    go(getSkippedStep(step))
  }
  const keyboard = (event: KeyboardEvent<HTMLElement>) => {
    const element = event.target as HTMLElement
    if (element.closest('[role="dialog"], [role="alertdialog"]')) return
    if (event.key === "Escape") {
      event.preventDefault()
      back()
      return
    }
    if (
      event.key !== "Enter" ||
      event.nativeEvent.isComposing ||
      event.shiftKey ||
      element.closest(".ob-agent-card,.ob-api-editor,.machine-settings") ||
      element.matches("textarea,button,select,input[type=checkbox],input[type=file]")
    )
      return
    event.preventDefault()
    if (!isDisabled) void next()
  }
  const isDisabled =
    busy ||
    (step === "workspace" && !draft.name.trim()) ||
    (step === "sources" && (!imports.selected.length || imports.busy)) ||
    (step === "manual" && (!manual.trim() || imports.busy)) ||
    (step === "review" && imports.selectionCount > 19) ||
    (step === "review" &&
      !Object.values(imports.selection).some((agents) =>
        Object.values(agents).some((item) => Object.values(item).some(Boolean)),
      )) ||
    (["computer", "agents"].includes(step) && imports.busy) ||
    (step === "task" && !task.trim())
  const canSkip = ["context", "sources", "manual", "review", "team"].includes(step)
  const replies = getReplies(step, draft, computerName)
  return (
    <GuideLayout
      onKeyDown={keyboard}
      step={step}
      draft={draft}
      bots={getLiveBots(bots, imports)}
      progress={imports.progress}
      replies={replies}
      computer={computerName}
      team={invited}
      task={task}
      routine={getRoutineNames(imports, false)[0] ?? ""}
      busy={busy || imports.busy}
      error={error ?? (step !== "sources" ? imports.error : null)}
      heading={heading}
      onBack={back}
    >
      {step === "workspace" && <WorkspaceFields draft={draft} onChange={setDraft} />}
      {step === "context" && <ContextFields draft={draft} onChange={setDraft} />}
      {notice && step === "sources" && (
        <p className="ob-notice" role="status">
          {notice}
        </p>
      )}
      {["sources", "review", "importing"].includes(step) && (
        <AgentImport
          step={step}
          imports={imports}
          api={api}
          invoke={invoke}
          onManual={() => go("manual")}
          onUndo={undoImport}
        />
      )}
      {step === "review" && imports.selectionCount > 19 && (
        <p className="ob-error" role="alert">
          {t("ob.importLimit")}
        </p>
      )}
      {step === "manual" && <ManualImport value={manual} onChange={setManual} />}
      {step === "computer" && (
        <ComputerFields api={api} values={computer} computer={computerName} onChange={setComputer} />
      )}
      {step === "agents" && (
        <AgentFields
          api={api}
          bots={bots}
          onChange={(bot) => setBots((previous) => previous.map((item) => (item.id === bot.id ? bot : item)))}
        />
      )}
      {step === "team" && <TeamFields api={api} groups={groups} onInvited={() => setInvited(true)} />}
      {step === "task" && (
        <>
          <label className="ob-field">
            {t("ob.taskAgent")}
            <select value={target} onChange={(event) => setTarget(event.target.value)}>
              {bots.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </select>
          </label>
          <div className="ob-suggestions">
            {getSuggestions(draft, getRoutineNames(imports, true)).map((suggestion) => (
              <Button key={suggestion} aria-pressed={task === suggestion} onClick={() => setTask(suggestion)}>
                {suggestion}
              </Button>
            ))}
          </div>
          <label className="ob-field">
            {t("ob.writeTask")}
            <textarea rows={3} value={task} maxLength={8000} onChange={(event) => setTask(event.target.value)} />
          </label>
        </>
      )}
      {step === "ready" && (
        <p className="ob-notice">
          {t("ob.taskSent")} #{groups.find((group) => group.name === "geral")?.name}
          {thread && <span className="ob-muted"> · {bots.map((bot) => bot.name).join(", ")}</span>}
        </p>
      )}
      {imports.error && step === "importing" && (
        <div className="ob-inline">
          <Button onClick={() => void imports.apply()}>{t("ob.retryImport")}</Button>
          <Button
            onClick={() => {
              imports.clearPreview()
              go("sources")
            }}
          >
            {t("ob.reviewSources")}
          </Button>
        </div>
      )}
      <footer className="ob-actions">
        <Button variant="primary" disabled={isDisabled} onClick={() => void next()}>
          {getNextLabel(step, busy, imports.busy)} <kbd>↵</kbd>
        </Button>
        {canSkip && (
          <Button variant="quiet" disabled={busy || imports.busy} onClick={skip}>
            {t("ob.skip")}
          </Button>
        )}
      </footer>
    </GuideLayout>
  )
}
const getPrevious = (step: GuideStep, hasTeam: boolean, hasPreviews: boolean): GuideStep => {
  if (step === "context") return "workspace"
  if (step === "sources") return "context"
  if (["manual", "review", "computer"].includes(step)) return "sources"
  if (step === "importing") return hasPreviews ? "review" : "sources"
  if (step === "agents") return "computer"
  if (step === "team") return "agents"
  return hasTeam ? "team" : "agents"
}
const getReplies = (step: GuideStep, draft: WorkspaceDraft, computer: string): string[] => {
  const stage = getStage(step)
  return [stage > 0 ? draft.name : "", stage > 1 ? draft.context : "", stage > 3 ? computer : ""]
    .filter(Boolean)
    .map((reply) => (reply.length > 120 ? `${reply.slice(0, 120)}…` : reply))
}
const getNextLabel = (step: GuideStep, busy: boolean, importing: boolean): string => {
  if (busy) return t("Aguarde…")
  if (step === "review") return t("ob.importSelected")
  if (step === "importing" && importing) return t("ob.continueImporting")
  if (step === "task") return t("ob.startTask")
  if (step === "ready") return t("ob.openGeneral")
  return t("ob.continue")
}
const getSuggestions = (draft: WorkspaceDraft, routines: string[]): string[] => [
  t("ob.contextTask", { name: draft.name }),
  ...draft.topics
    .slice(0, 2)
    .map((topic) =>
      t("ob.topicTask", { topic: t(topicOptions.find((option) => option.id === topic)?.label ?? "ob.operations") }),
    ),
  ...routines.slice(0, 2).map((name) => t("ob.routineTask", { name: JSON.stringify(name) })),
]

const getRoutineNames = (imports: ReturnType<typeof useAgentImport>, completedOnly: boolean): string[] =>
  imports.previews.flatMap(({ preview }) => {
    const result = imports.results.find((item) => item.importId === imports.importIds[preview.previewId])
    return preview.agents
      .filter(
        (agent) =>
          imports.selection[preview.previewId]?.[agent.key]?.routines &&
          (!completedOnly || result?.bots.some((bot) => bot.agentKey === agent.key)),
      )
      .flatMap((agent) => agent.routines.map((routine) => routine.name))
  })

const getLiveBots = (bots: Bot[], imports: ReturnType<typeof useAgentImport>) => {
  const copying = imports.previews.flatMap(({ preview }) => {
    const importId = imports.importIds[preview.previewId]
    const result = imports.results.find((item) => item.importId === importId)
    return preview.agents
      .filter((agent) => {
        const imported = result?.bots.find((item) => item.agentKey === agent.key)
        return (
          !bots.some((bot) => bot.id === imported?.botId) &&
          Object.values(imports.selection[preview.previewId]?.[agent.key] ?? {}).some(Boolean)
        )
      })
      .map((agent) => ({
        id: `${preview.previewId}:${agent.key}`,
        ...(importId ? { importId } : {}),
        agentKey: agent.key,
        name: agent.suggestedBotName,
        color: null,
        avatarSeed: agent.key,
      }))
  })
  return [...bots, ...copying]
}

const getGuideEndpoint = async (invoke: TauriInvoke): Promise<Endpoint> => {
  const [endpoint, mode] = await Promise.all([resolveSidecarEndpoint(invoke), invoke("server_mode_status", {})])
  if (mode?.mode !== "server" || !mode.url) return endpoint
  return { ...endpoint, scope: mode.url }
}

const getComputerLabel = (host: HostKind): string => {
  if (host === "mac") return t("ob.thisComputer", { computer: "Mac" })
  if (host === "server") return t("Neste servidor")
  return t("setup.thisComputer")
}

const getSkippedStep = (step: GuideStep): GuideStep => {
  if (step === "team") return "task"
  if (step === "context") return "sources"
  return "computer"
}
