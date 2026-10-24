import type { Bot, Message, Run } from "@touri/contracts"
import type { AvatarIdentity, AvatarMood } from "@touri/contracts/avatar"
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import type { WorkspaceData } from "../useWorkspace"
import { MascotMachine, type MascotSnapshot, type MascotState, mascotMoodFor, mascotSignalFor } from "./mascotState"

export type AvatarRuntime = Pick<
  WorkspaceData,
  "bots" | "runs" | "messages" | "threads" | "notifications" | "loading"
> &
  Partial<Pick<WorkspaceData, "computerGrantRequest" | "machines">>
type ComposerEvent = { botId: string; threadId: string; focused: boolean; typing: boolean }
type RuntimeValue = {
  snapshots: ReturnType<typeof createSnapshotStore>
  data: ReturnType<typeof createDataStore>
  composer: (event: ComposerEvent) => void
}
type MachineView = { snapshots: ReadonlyMap<string, MascotSnapshot>; deadline: number | null }
const RuntimeContext = createContext<RuntimeValue | null>(null)
const scopeKey = (botId: string, threadId?: string): string => JSON.stringify([botId, threadId ?? null])
const getMachineView = (machines: ReadonlyMap<string, MascotMachine>): MachineView => {
  const deadlines = [...machines.values()].flatMap((machine) => (machine.deadline === null ? [] : [machine.deadline]))
  return {
    snapshots: new Map([...machines].map(([key, machine]) => [key, machine.snapshot])),
    deadline: deadlines.length ? Math.min(...deadlines) : null,
  }
}

const completionStamps = (runtime: AvatarRuntime): Map<string, number> => {
  const stamps = new Map<string, number>()
  const note = (botId: string | null, at: number): void => {
    if (botId) stamps.set(botId, Math.max(stamps.get(botId) ?? 0, at))
  }
  const threadBots = new Map(runtime.threads.map((thread) => [thread.id, thread.botId]))
  for (const message of runtime.messages) {
    if (message.role === "assistant" && message.status === "complete")
      note(threadBots.get(message.threadId) ?? null, message.updatedAt)
  }
  for (const run of runtime.runs)
    if (run.status === "succeeded" && run.replyMessageId) note(run.botId, run.finishedAt ?? 0)
  for (const item of runtime.notifications) if (item.kind === "done") note(item.botId, item.createdAt)
  return stamps
}

const runtimeSignals = (runtime: AvatarRuntime, recentReplies: ReadonlySet<string>) => {
  const botIds = new Set([...runtime.bots.map((bot) => bot.id), ...runtime.runs.map((run) => run.botId)])
  const signals = new Map<string, ReturnType<typeof mascotSignalFor>>()
  for (const botId of botIds) {
    const threads = runtime.threads.filter((thread) => thread.botId === botId)
    const threadIds = new Set(threads.map((thread) => thread.id))
    const messages = runtime.messages.filter((message) => threadIds.has(message.threadId))
    const shared = {
      botId,
      paused: runtime.bots.find((bot) => bot.id === botId)?.paused ?? false,
      runs: runtime.runs,
      messages,
      notifications: runtime.notifications,
      recentReply: recentReplies.has(botId),
      waiting: threadIds.has(runtime.computerGrantRequest?.threadId ?? ""),
      machine: runtime.machines?.find((machine) => machine.botId === botId),
    }
    signals.set(scopeKey(botId), mascotSignalFor(shared))
    for (const thread of threads)
      signals.set(
        scopeKey(botId, thread.id),
        mascotSignalFor({
          ...shared,
          runs: runtime.runs.filter((run) => run.threadId === thread.id),
          messages: messages.filter((message) => message.threadId === thread.id),
          notifications: runtime.notifications.filter((item) => item.threadId === thread.id),
          recentReply: false,
          waiting: runtime.computerGrantRequest?.threadId === thread.id,
        }),
      )
  }
  return signals
}

/** One machine per bot and conversation; every avatar on a surface observes the same snapshot. */
export const AvatarRuntimeProvider = ({ value, children }: { value: AvatarRuntime; children: ReactNode }) => {
  const [recentReplies, setRecentReplies] = useState<ReadonlySet<string>>(new Set())
  const previous = useRef(completionStamps(value))
  const previousLoading = useRef(value.loading)
  const [machines] = useState(() => {
    const now = performance.now()
    return new Map([...runtimeSignals(value, new Set())].map(([key, signal]) => [key, new MascotMachine(signal, now)]))
  })
  const [snapshots] = useState(() => createSnapshotStore(getMachineView(machines).snapshots))
  const [deadline, setDeadline] = useState(() => getMachineView(machines).deadline)
  const publish = useCallback(() => {
    const next = getMachineView(machines)
    snapshots.publish(next.snapshots)
    setDeadline(next.deadline)
  }, [machines, snapshots])

  useEffect(() => {
    const current = completionStamps(value)
    const completed = [...current].filter(([id, at]) => at > (previous.current.get(id) ?? 0)).map(([id]) => id)
    previous.current = current
    const hydrated = !value.loading && !previousLoading.current
    previousLoading.current = value.loading
    if (!hydrated || completed.length === 0 || (document.hasFocus() && !document.hidden)) return
    setRecentReplies((existing) => new Set([...existing, ...completed]))
  }, [value])
  // Register runtime scopes before composer effects can address a newly selected conversation.
  useLayoutEffect(() => {
    const now = performance.now()
    const signals = runtimeSignals(value, recentReplies)
    for (const key of machines.keys()) if (!signals.has(key)) machines.delete(key)
    for (const [key, signal] of signals) {
      const machine = machines.get(key) ?? new MascotMachine(signal, now)
      machines.set(key, machine)
      machine.send({ type: "runtime", signal }, now)
    }
    publish()
  }, [value, recentReplies, machines, publish])

  useEffect(() => {
    if (deadline === null) return
    const timer = window.setTimeout(
      () => {
        // Browsers round timer delays; the scheduled deadline is the earliest valid tick.
        const now = Math.max(deadline, performance.now())
        for (const machine of machines.values()) machine.send({ type: "tick" }, now)
        publish()
      },
      Math.max(0, deadline - performance.now()),
    )
    return () => window.clearTimeout(timer)
  }, [deadline, machines, publish])

  useEffect(() => {
    const clear = (): void => setRecentReplies(new Set())
    const visibility = (): void => {
      if (!document.hidden && document.hasFocus()) clear()
    }
    window.addEventListener("focus", clear)
    document.addEventListener("visibilitychange", visibility)
    return () => {
      window.removeEventListener("focus", clear)
      document.removeEventListener("visibilitychange", visibility)
    }
  }, [])
  const composer = useCallback(
    (event: ComposerEvent): void => {
      const now = performance.now()
      for (const key of [scopeKey(event.botId), scopeKey(event.botId, event.threadId)])
        machines.get(key)?.send({ type: "composer", focused: event.focused, typing: event.typing }, now)
      publish()
    },
    [machines, publish],
  )
  // Readers select what they show from this store, so a streaming delta does not re-render every avatar.
  const [data] = useState(() => createDataStore(value))
  useLayoutEffect(() => data.publish(value), [data, value])
  const runtime = useMemo(() => ({ snapshots, data, composer }), [snapshots, data, composer])

  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>
}

/** Reads one value from the workspace data; the component renders again only when that value changes. */
const useRuntimeSelector = <T,>(select: (value: AvatarRuntime) => T, fallback: T): T => {
  const runtime = useContext(RuntimeContext)
  const getSnapshot = () => (runtime ? select(runtime.data.get()) : fallback)

  return useSyncExternalStore(runtime?.data.subscribe ?? subscribeWithoutRuntime, getSnapshot)
}

export const useAvatarBot = (id: string | null): Bot | undefined =>
  useRuntimeSelector((value) => value.bots.find((bot) => bot.id === id), undefined)

export const useThreadBot = (threadId: string): Bot | undefined =>
  useRuntimeSelector((value) => {
    const botId = value.threads.find((thread) => thread.id === threadId)?.botId
    return value.bots.find((bot) => bot.id === botId)
  }, undefined)

export const useMascotComposer = (): RuntimeValue["composer"] | undefined => useContext(RuntimeContext)?.composer

export const useMascotSnapshot = (
  identity: AvatarIdentity & { paused?: boolean },
  threadId?: string,
): MascotSnapshot => {
  const runtime = useContext(RuntimeContext)
  const snapshot = useRuntimeSnapshot(runtime, identity.id, threadId)
  return identity.paused
    ? { state: "sleeping", phase: "asleep", since: 0, revision: 0 }
    : (snapshot ?? { state: "idle", phase: "idle", since: 0, revision: 0 })
}

export const useAvatarMood = (identity: AvatarIdentity & { paused?: boolean }, override?: AvatarMood): AvatarMood => {
  const loading = useRuntimeSelector((value) => value.loading, false)
  const snapshot = useMascotSnapshot(identity)
  return override ?? (loading && snapshot.state === "idle" ? "connecting" : mascotMoodFor(snapshot.state))
}

export const useMessageMascotState = (message: Message, run?: Run): MascotState => {
  const runtime = useContext(RuntimeContext)
  const botId = useRuntimeSelector(
    (value) => run?.botId ?? value.threads.find((thread) => thread.id === message.threadId)?.botId ?? "",
    run?.botId ?? "",
  )
  const snapshot = useRuntimeSnapshot(runtime, botId, message.threadId)
  const fallback = useRuntimeSelector(
    (value) =>
      mascotSignalFor({
        botId,
        runs: run ? [run] : [],
        messages: [message],
        notifications: value.notifications.filter((item) => item.threadId === message.threadId),
        waiting: value.computerGrantRequest?.threadId === message.threadId,
      }).state,
    mascotSignalFor({ botId, runs: run ? [run] : [], messages: [message], notifications: [], waiting: false }).state,
  )
  return snapshot ? snapshot.state : fallback
}

const createSnapshotStore = (initial: ReadonlyMap<string, MascotSnapshot>) => {
  // React's external store API needs synchronous snapshots and subscription lifetimes.
  let snapshots = initial
  const listeners = new Set<() => void>()

  return {
    getSnapshot: (key: string) => snapshots.get(key),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    publish: (next: ReadonlyMap<string, MascotSnapshot>) => {
      if (snapshots.size === next.size && Array.from(next).every(([key, snapshot]) => snapshots.get(key) === snapshot))
        return

      snapshots = next
      listeners.forEach((listener) => {
        listener()
      })
    },
  }
}

const createDataStore = (initial: AvatarRuntime) => {
  // Same external-store contract as the snapshots: synchronous reads and explicit subscriptions.
  let current = initial
  const listeners = new Set<() => void>()

  return {
    get: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    publish: (next: AvatarRuntime) => {
      if (next === current) return
      current = next
      listeners.forEach((listener) => {
        listener()
      })
    },
  }
}

const subscribeWithoutRuntime = () => () => {}
const useRuntimeSnapshot = (runtime: RuntimeValue | null, botId: string, threadId?: string) => {
  const key = scopeKey(botId, threadId)
  const getSnapshot = () => runtime?.snapshots.getSnapshot(key)

  return useSyncExternalStore(runtime?.snapshots.subscribe ?? subscribeWithoutRuntime, getSnapshot)
}
