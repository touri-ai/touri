import { afterEach, expect, mock, test } from "bun:test"
import type {
  Kernel,
  ProviderAdapter,
  RouteHandler,
  RouteModule,
  Run,
  ServiceMap,
  StartTurnArgs,
  ToolContext,
} from "@touri/contracts"
import { createChannelBrowserRuns, getBrowserCancellationTarget } from "../../src/browser/channel-runs"
import type { AuthStore } from "../../src/cli/auth/store"
import { createWorkAccess } from "../../src/cli/work-access"
import type { createGroupRuntime } from "../../src/groups/runtime"
import { createGroupStore } from "../../src/groups/store"
import { bindDeviceSession, type DevicePerson } from "../../src/kernel/device-session"
import { init as initRuntime } from "../../src/runtime"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { init as initStore } from "../../src/store"
import { testKernel } from "../kernel/test-kernel"

const cleanups = new Set<() => Promise<void>>()

afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

test.each(["member", "admin"] as const)(
  "live cancellation denies an unrelated %s through the browser request and its group root",
  async (role) => {
    const fixture = await getFixture()
    const browser = await fixture.startBrowser()
    const before = fixture.getSnapshot()

    const responses = await Promise.all(
      [browser.runId, fixture.active.id].map((runId) => fixture.cancel(runId, getPerson("unrelated", role))),
    )

    responses.forEach((response) => {
      expectForbidden(response)
    })
    fixture.expectUnchanged(before)
  },
)

test.each(["member", "admin"] as const)(
  "live cancellation of later queued roots or ordinary child aliases denies an unrelated %s before group effects",
  async (role) => {
    const fixture = await getFixture()
    await fixture.startBrowser()
    const before = fixture.getSnapshot()

    const responses = await Promise.all(
      [fixture.waiting.id, fixture.last.id, fixture.coordinator.run.id].map((runId) =>
        fixture.cancel(runId, getPerson("unrelated", role)),
      ),
    )

    responses.forEach((response) => {
      expectForbidden(response)
    })
    fixture.expectUnchanged(before)
  },
)

test("every delegated browser child is checked before aborting an authorized peer or changing queued roots", async () => {
  const fixture = await getFixture()
  await fixture.startBrowser()
  await fixture.startBrowser("peer", "other-requester", "other-responsible")
  const before = fixture.getSnapshot()

  const response = await fixture.cancel(fixture.waiting.id, getPerson("requester"))

  expectForbidden(response)
  fixture.expectUnchanged(before)
})

test("canceling a browser caller checks the protected work its delegation would abort", async () => {
  const fixture = await getFixture()
  const browser = await fixture.startBrowser()
  await fixture.startBrowser("peer", "requester", "peer-responsible", browser)
  const before = fixture.getSnapshot()

  const response = await fixture.cancel(browser.runId, getPerson("responsible"))

  expectForbidden(response)
  fixture.expectUnchanged(before)
})

test("the requester can cancel a browser caller and its delegated browser work", async () => {
  const fixture = await getFixture()
  const browser = await fixture.startBrowser()
  const peer = await fixture.startBrowser("peer", "requester", "peer-responsible", browser)

  const response = await fixture.cancel(browser.runId, getPerson("requester"))
  await Promise.all([fixture.waitForCanceled(browser.runId), fixture.waitForCanceled(peer.runId)])

  expect(response.status).toBe(200)
  expect(fixture.channelRuns.get(browser.runId)?.status).toBe("canceled")
  expect(fixture.channelRuns.get(peer.runId)?.status).toBe("canceled")
})

test.each(["member", "admin"] as const)(
  "delegated continuation aliases and later queued roots deny an unrelated %s without effects",
  async (role) => {
    const fixture = await getFixture()
    const browser = await fixture.startBrowser()
    const originalId = fixture.addContinuationAlias(browser.runId)
    const before = fixture.getSnapshot()

    const responses = await Promise.all(
      [originalId, browser.runId, fixture.waiting.id].map((runId) =>
        fixture.cancel(runId, getPerson("unrelated", role)),
      ),
    )

    responses.forEach((response) => {
      expectForbidden(response)
    })
    fixture.expectUnchanged(before)
  },
)

test("a denied stop preserves the queued requests and their execution order", async () => {
  const fixture = await getFixture()
  const browser = await fixture.startBrowser()

  expectForbidden(await fixture.cancel(fixture.waiting.id, getPerson("unrelated")))
  fixture.complete(browser.runId)
  fixture.coordinator.complete()
  const second = await fixture.waitForGroupStart(fixture.waiting.id)
  expect(fixture.getRun(fixture.last.id)?.status).toBe("queued")
  second.complete()
  const third = await fixture.waitForGroupStart(fixture.last.id)
  third.complete()
  await fixture.groups.waitForDrain()

  expect(fixture.getRun(fixture.active.id)?.status).toBe("succeeded")
  expect(fixture.getRun(fixture.waiting.id)?.status).toBe("succeeded")
  expect(fixture.getRun(fixture.last.id)?.status).toBe("succeeded")
  expect(fixture.getProviderStarts()).toBe(4)
})

test.each([
  getPerson("requester"),
  getPerson("responsible"),
  getPerson("requester", "admin"),
  getPerson("responsible", "admin"),
])("$id ($role) can stop the complete group through a later ordinary queued root", async (person) => {
  const fixture = await getFixture()
  const browser = await fixture.startBrowser()

  const response = await fixture.cancel(fixture.waiting.id, person)
  await fixture.groups.waitForDrain()
  await fixture.waitForCanceled(browser.runId)

  expect(response.status).toBe(200)
  expect(fixture.getRun(fixture.active.id)?.status).toBe("canceled")
  expect(fixture.getRun(fixture.waiting.id)?.status).toBe("canceled")
  expect(fixture.getRun(fixture.last.id)?.status).toBe("canceled")
  expect(fixture.getRun(browser.runId)?.status).toBe("canceled")
  expect(fixture.channelRuns.get(browser.runId)?.status).toBe("canceled")
  expect(fixture.coordinator.signal.aborted).toBe(true)
  expect(fixture.getProviderStarts()).toBe(2)
  expect(fixture.released).toEqual([browser.runId])
})

test.each([getPerson("requester"), getPerson("responsible"), getPerson("responsible", "admin")])(
  "$id ($role) can stop one browser request while an unrelated protected request in the same group survives",
  async (person) => {
    const fixture = await getFixture()
    const browser = await fixture.startBrowser()
    const peer = await fixture.startBrowser("peer", "other-requester", "other-responsible")

    const response = await fixture.cancel(browser.runId, person)

    expect(response.status).toBe(200)
    expect(fixture.channelRuns.get(browser.runId)?.status).toBe("canceled")
    expect(browser.signal.aborted).toBe(true)
    expect(fixture.channelRuns.get(peer.runId)?.status).toBe("running")
    expect(peer.signal.aborted).toBe(false)
    expect(fixture.coordinator.signal.aborted).toBe(false)
    expect(fixture.getRun(fixture.active.id)?.status).toBe("running")
    expect(fixture.getRun(fixture.waiting.id)?.status).toBe("queued")
    expect(fixture.getRun(fixture.last.id)?.status).toBe("queued")
    expect(fixture.released).toEqual([browser.runId])
  },
)

test("inaccessible roots and children return 404 before disclosing browser ownership", async () => {
  const fixture = await getFixture()
  const browser = await fixture.startBrowser()
  const before = fixture.getSnapshot()

  const responses = await Promise.all(
    [fixture.active.id, fixture.waiting.id, fixture.coordinator.run.id, browser.runId, "missing"].map((runId) =>
      fixture.cancel(runId, getPerson("outsider")),
    ),
  )

  responses.forEach((response) => {
    expect(response).toMatchObject({ status: 404, json: { errorCode: "NOT_FOUND" } })
  })
  fixture.expectUnchanged(before)
})

test("a browser group-root short circuit cancels only the authorized request once", async () => {
  const fixture = await getFixture()
  const browser = await fixture.startBrowser()
  const peer = await fixture.startBrowser("peer", "other-requester", "other-responsible")
  const target = fixture.getBrowserTarget(fixture.active.id)
  if (!target) throw new Error("Missing browser cancellation target")
  const isBrowser = target.runId === browser.runId
  const selected = isBrowser ? browser : peer
  const surviving = isBrowser ? peer : browser
  const person = getPerson(isBrowser ? "requester" : "other-requester")

  const response = await fixture.cancel(fixture.active.id, person)

  expect(selected.signal.aborted).toBe(true)
  expect(surviving.signal.aborted).toBe(false)
  expect(fixture.coordinator.signal.aborted).toBe(false)
  expect(fixture.channelRuns.get(surviving.runId)?.status).toBe("running")
  expect(fixture.getRun(fixture.waiting.id)?.status).toBe("queued")
  expect(fixture.released).toEqual([target.requestId])
  expect(response).toMatchObject({ status: 200, json: { run: { id: fixture.active.id } } })
})

test("the responsible person can cancel a delegated continuation through its original alias in isolation", async () => {
  const fixture = await getFixture()
  const browser = await fixture.startBrowser()
  const originalId = fixture.addContinuationAlias(browser.runId)
  const peer = await fixture.startBrowser("peer", "other-requester", "other-responsible")

  const response = await fixture.cancel(originalId, getPerson("responsible", "admin"))

  expect(response.status).toBe(200)
  expect(browser.signal.aborted).toBe(true)
  expect(peer.signal.aborted).toBe(false)
  expect(fixture.coordinator.signal.aborted).toBe(false)
  expect(fixture.channelRuns.get(originalId)?.status).toBe("canceled")
  expect(fixture.channelRuns.get(peer.runId)?.status).toBe("running")
  expect(fixture.getRun(fixture.waiting.id)?.status).toBe("queued")
  expect(fixture.released).toEqual([originalId])
})

test.each([getPerson("unrelated"), getPerson("unrelated", "admin"), undefined])(
  "ordinary group stop remains available to $id ($role) and native callers",
  async (person) => {
    const fixture = await getFixture(person !== undefined)

    const response = await fixture.cancel(fixture.waiting.id, person)
    await fixture.groups.waitForDrain()

    expect(response.status).toBe(200)
    expect(fixture.getRun(fixture.active.id)?.status).toBe("canceled")
    expect(fixture.getRun(fixture.waiting.id)?.status).toBe("canceled")
    expect(fixture.getRun(fixture.last.id)?.status).toBe("canceled")
    expect(fixture.coordinator.signal.aborted).toBe(true)
    expect(fixture.getProviderStarts()).toBe(1)
  },
)

test("native callers retain trusted cancellation of protected browser work without a device session", async () => {
  const fixture = await getFixture()
  const browser = await fixture.startBrowser()

  const response = await fixture.cancel(fixture.waiting.id)
  await fixture.groups.waitForDrain()

  expect(response.status).toBe(200)
  expect(fixture.channelRuns.get(browser.runId)?.status).toBe("canceled")
  expect(fixture.getRun(fixture.last.id)?.status).toBe("canceled")
})

test.each([getPerson("unrelated", "admin"), undefined])(
  "existing cloud cancellation forwards runs without a local run record",
  async (person) => {
    const fixture = await getFixture()
    const cloud = fixture.registerCloudRun()

    const response = await fixture.cancel("cloud-run", person)

    expect(response).toMatchObject({ status: 200, json: cloud.response })
    expect(cloud.request.mock.calls).toEqual([["POST", "/v1/runs/cloud-run/cancel", {}]])
  },
)

function getPerson(id: string, role: DevicePerson["role"] = "member"): DevicePerson {
  return { id, name: `Fixture ${id}`, avatarSeed: id, email: null, role }
}

const expectForbidden = (response: Awaited<ReturnType<RouteHandler>>) =>
  expect(response).toMatchObject({ status: 403, json: { errorCode: "BROWSER_CONTROL_FORBIDDEN" } })

const getFixture = async (workMode = true) => {
  const base = testKernel()
  const routes = new Map<string, RouteHandler>()
  const kernel: Kernel = Object.assign({}, base.kernel, {
    registerRoutes: (module: RouteModule) => {
      module.routes.forEach((route) => {
        routes.set(`${route.method} ${route.path}`, route.handler)
      })
    },
  })
  await initStore(kernel)
  const store = kernel.services.use("store.api")
  if (!store) throw new Error("Missing store")
  const persistence = createRuntimePersistence({ database: base.db })
  const starts = new Map(
    ["coordinator", "browser", "peer"].map((botId) => [botId, Promise.withResolvers<StartedTurn>()]),
  )
  const groupStarts = new Map<string, ReturnType<typeof Promise.withResolvers<StartedTurn>>>()
  const completions = new Map<string, () => void>()
  const signals = new Set<AbortSignal>()
  const provider: ProviderAdapter = {
    provider: "codex",
    detect: async () => ({ success: true, path: "/fixture/provider", version: "fixture", loggedIn: true }),
    startTurn: (args) =>
      new Promise((resolve) => {
        const run = kernel.services.use("runtime.activeRun")?.({ threadId: args.thread.id })
        if (!run) throw new Error("Missing active provider run")
        signals.add(args.signal)
        const finish = (status: "succeeded" | "interrupted") => {
          args.signal.removeEventListener("abort", abort)
          args.onEvent({ type: "turn_completed", status, errorClass: null, errorMessage: null })
          resolve({ success: true, externalSessionId: args.thread.id, rolloutPath: null, status })
        }
        const abort = () => finish("interrupted")
        const complete = () => finish("succeeded")
        completions.set(run.id, complete)
        args.signal.addEventListener("abort", abort, { once: true })
        args.onEvent({ type: "turn_started", externalTurnId: args.thread.id })
        const started = Object.assign({}, args, { run, complete })
        starts.get(args.bot.id)?.resolve(started)
        const link = base.db
          .query<{ turn_id: string }, [string]>("SELECT turn_id FROM group_run_links WHERE run_id = ?")
          .get(run.id)
        if (link && args.bot.id === "coordinator") groupStarts.get(link.turn_id)?.resolve(started)
      }),
    answerApproval: async () => ({ success: true }),
    shutdown: async () => {},
  }
  await initRuntime(kernel, undefined, { providerAdapters: { codex: provider } })
  const groups = kernel.services.use("groups.runtime") as ReturnType<typeof createGroupRuntime>
  const channelRuns = createChannelBrowserRuns({ kernel, database: base.db })
  const cancelBrowserRequest = mock((runId: string) => channelRuns.cancelRequest(runId))
  const getReleased = () =>
    cancelBrowserRequest.mock.results.flatMap((result) =>
      result.type === "return" && result.value ? [result.value.requestId] : [],
    )
  const delegations = new Set<Promise<unknown>>()
  kernel.services.provide("browser.cancelRequest", ({ runId }) => {
    const canceled = cancelBrowserRequest(runId)
    if (!canceled) return null
    return canceled.runId
  })
  cleanups.add(async () => {
    await kernel.services.use("runtime.shutdown")?.()
    await Promise.all(delegations)
    channelRuns.dispose()
    base.close()
  })
  starts.forEach((_, botId) => {
    base.db
      .query(`INSERT INTO bots(id,name,provider,home_dir,access,approvals,created_at,updated_at,responsible_person_id)
        VALUES (?,?,'codex',?,'full','never',1,1,'responsible')`)
      .run(botId, botId, kernel.paths.appData)
  })
  const groupStore = createGroupStore(kernel)
  const group = groupStore.save({
    name: "Fixture team",
    color: "#888888",
    avatarShape: "classic-none",
    memberIds: Array.from(starts.keys()),
    coordinatorBotId: "coordinator",
  })
  if (workMode) {
    const authStore: Pick<AuthStore, "getPersonChannelIds" | "getPerson"> = {
      getPersonChannelIds: (id) => (id === "outsider" ? [] : [group.id]),
      getPerson: () => null,
    }
    const access = createWorkAccess({ database: base.db, authStore: authStore as AuthStore })
    kernel.services.provide("work.authorizeHttp", access.authorizeHttp)
    kernel.services.provide("work.canAccessRun", access.canAccessRun)
    kernel.services.provide("work.personChannelIds", access.channelIdsFor)
  }
  const thread = groupStore.createThread(group)
  const otherThread = groupStore.createThread(group, "Other fixture conversation")
  const send = (threadId: string): Run => {
    const request = store.insertMessage({
      message: {
        id: kernel.newId(),
        threadId,
        parentId: store.getThread({ threadId })?.activeLeafId ?? null,
        role: "user",
        kind: "text",
        status: "complete",
        runId: null,
        text: "Fixture request",
        parts: [],
        sender: { id: "requester", name: "Fixture requester", kind: "person" },
        source: "local",
      },
    })
    if (!request.success) throw new Error(request.error)
    const result = groups.enqueue({ threadId, requestMessageId: request.message.id, trigger: "user" })
    if (!result.success) throw new Error(result.error)
    groupStarts.set(result.run.id, Promise.withResolvers<StartedTurn>())
    return result.run
  }
  const active = send(thread.id)
  const coordinator = await getStarted(starts, "coordinator")
  const waiting = send(otherThread.id)
  const last = send(thread.id)
  const getSnapshot = () => ({
    runs: base.db.query("SELECT * FROM runs ORDER BY id").all(),
    browser: base.db.query("SELECT * FROM browser_channel_runs ORDER BY run_id").all(),
    messages: base.db.query("SELECT * FROM messages ORDER BY id").all(),
    links: base.db.query("SELECT * FROM group_run_links ORDER BY run_id").all(),
  })

  return {
    active,
    coordinator,
    waiting,
    last,
    groups,
    channelRuns,
    get released() {
      return getReleased()
    },
    getSnapshot,
    getRun: persistence.getRun,
    getBrowserTarget: (runId: string) => getBrowserCancellationTarget(base.db, runId),
    getProviderStarts: () => signals.size,
    registerCloudRun: () => {
      base.db.query("INSERT INTO cloud_runs(run_id,bot_id) VALUES ('cloud-run','coordinator')").run()
      const response = { run: { id: "cloud-run", status: "canceled" } }
      const request = mock(async (_method: string, _path: string, _body?: unknown) => response)
      const unexpectedCloudCall = async () => {
        throw new Error("Unexpected cloud operation")
      }
      const cloud: ServiceMap["cloud.account"] = {
        request: async <T>(method: string, path: string, body?: unknown) => (await request(method, path, body)) as T,
        uploadReport: unexpectedCloudCall,
        state: unexpectedCloudCall,
        connected: async () => true,
        createBot: unexpectedCloudCall,
        send: unexpectedCloudCall,
        machine: unexpectedCloudCall,
        park: unexpectedCloudCall,
        wake: unexpectedCloudCall,
      }
      kernel.services.provide("cloud.account", cloud)

      return { request, response }
    },
    waitForGroupStart: async (runId: string) => {
      const started = groupStarts.get(runId)
      if (!started) throw new Error("Missing group start hook")
      return started.promise
    },
    complete: (runId: string) => completions.get(runId)?.(),
    addContinuationAlias: (runId: string) => {
      const run = persistence.getRun(runId)
      if (!run) throw new Error("Missing continuation run")
      const originalId = `original-${runId}`
      persistence.saveRun(
        Object.assign({}, run, { id: originalId, status: "succeeded" as const, finishedAt: Date.now() }),
      )
      base.db.query("INSERT INTO group_run_links VALUES (?,?,1)").run(originalId, active.id)
      base.db
        .query(`INSERT INTO browser_takeover_continuations(run_id,original_run_id,previous_run_id,created_at)
          VALUES (?,?,?,1)`)
        .run(runId, originalId, originalId)
      base.db.query("UPDATE browser_channel_runs SET run_id = ? WHERE run_id = ?").run(originalId, runId)
      return originalId
    },
    waitForCanceled: (runId: string) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          unsubscribe()
          reject(new Error("Canceled child did not settle"))
        }, 2000)
        const check = () => {
          if (persistence.getRun(runId)?.status !== "canceled") return
          clearTimeout(timer)
          unsubscribe()
          resolve()
        }
        const unsubscribe = kernel.subscribe(check)
        check()
      }),
    expectUnchanged: (before: ReturnType<typeof getSnapshot>) => {
      expect(getSnapshot()).toEqual(before)
      expect(Array.from(signals).every((signal) => !signal.aborted)).toBe(true)
      expect(getReleased()).toEqual([])
    },
    startBrowser: async (
      botId = "browser",
      requester = "requester",
      responsible = "responsible",
      caller = getContext(coordinator),
    ) => {
      delegations.add(groups.askBot(caller, { bot: botId, message: "Fixture browser task" }))
      const args = await getStarted(starts, botId)
      const ctx = getContext(args)
      expect(await channelRuns.enter(ctx)).toEqual({ success: true })
      base.db
        .query("UPDATE browser_channel_runs SET requester_person_id = ?, responsible_person_id = ? WHERE run_id = ?")
        .run(requester, responsible, args.run.id)
      return Object.assign({}, ctx, { runId: args.run.id })
    },
    cancel: async (runId: string, person?: DevicePerson) => {
      const handler = routes.get("POST /runs/:id/cancel")
      if (!handler) throw new Error("Missing cancellation route")
      const signal = new AbortController().signal
      if (person) bindDeviceSession(signal, { deviceId: "fixture-device", person, active: () => true })
      return handler({ params: { id: runId }, body: null, query: {}, signal })
    },
  }
}

type StartedTurn = StartTurnArgs & { run: Run; complete: () => void }

const getStarted = async (
  starts: Map<string, ReturnType<typeof Promise.withResolvers<StartedTurn>>>,
  botId: string,
) => {
  const started = starts.get(botId)
  if (!started) throw new Error("Missing provider start hook")
  return started.promise
}

const getContext = (args: StartedTurn): ToolContext => ({
  runId: args.run.id,
  threadId: args.thread.id,
  botId: args.bot.id,
  projectId: null,
  cwd: args.bot.homeDir,
  signal: args.signal,
})
