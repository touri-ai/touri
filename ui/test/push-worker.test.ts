import { readFile } from "node:fs/promises"
import { URL as FileUrl } from "node:url"
import { runInNewContext } from "node:vm"
import { expect, it, vi } from "vitest"

type PushInput = { id: number; body: string; url: string }
type WorkerEvent = {
  data?: { text: () => string; json: () => PushInput }
  notification?: { close: () => void; data: { url: string } }
  waitUntil: (promise: Promise<unknown>) => void
}

const getWorker = async () => {
  const handlers = new Map<string, (event: WorkerEvent) => void>()
  const showNotification = vi.fn().mockResolvedValue(undefined)
  const openWindow = vi.fn().mockResolvedValue(undefined)
  const navigate = vi.fn().mockResolvedValue({ focus: vi.fn().mockResolvedValue(undefined) })
  const matchAll = vi.fn().mockResolvedValue([{ url: "https://touri.example/", navigate }])
  const source = await readFile(new FileUrl("../public/push-worker.js", import.meta.url), "utf8")
  const worker = {
    location: { origin: "https://touri.example" },
    registration: { showNotification },
    clients: { matchAll, openWindow },
    addEventListener: (type: string, handler: (event: WorkerEvent) => void) => handlers.set(type, handler),
  }
  runInNewContext(source, { self: worker, URL })
  const dispatch = async (type: string, event: Omit<WorkerEvent, "waitUntil">) => {
    const tasks: Promise<unknown>[] = []
    handlers.get(type)?.({
      ...event,
      waitUntil: (promise) => {
        tasks.push(promise)
      },
    })
    await Promise.all(tasks)
  }

  return { dispatch, showNotification, openWindow, navigate, matchAll }
}

it.each(["O bot terminou.", "O bot precisa de você.", "A tarefa falhou.", "Uma revisão está pronta."])(
  "displays the push event '%s' with a stable notification tag",
  async (body) => {
    const worker = await getWorker()
    const payload = { id: 42, body, url: "/?thread=demo&notification=42" }

    await worker.dispatch("push", { data: { text: () => JSON.stringify(payload), json: () => payload } })

    expect(worker.showNotification).toHaveBeenCalledWith(
      "touri",
      expect.objectContaining({
        body,
        tag: "touri-42",
        renotify: false,
        data: { url: "https://touri.example/?thread=demo&notification=42" },
      }),
    )
  },
)

it("clicking a notification opens the exact conversation in the existing app", async () => {
  const worker = await getWorker()
  const close = vi.fn()

  await worker.dispatch("notificationclick", {
    notification: { close, data: { url: "/?bot=demo&thread=conversation-2&notification=42" } },
  })

  expect(close).toHaveBeenCalledTimes(1)
  expect(worker.navigate).toHaveBeenCalledWith("https://touri.example/?bot=demo&thread=conversation-2&notification=42")
  expect(worker.openWindow).not.toHaveBeenCalled()
})

it("clicking a notification opens the app when all windows are closed", async () => {
  const worker = await getWorker()
  worker.matchAll.mockResolvedValue([])

  await worker.dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "/?thread=demo" } } })

  expect(worker.openWindow).toHaveBeenCalledWith("https://touri.example/?thread=demo")
})

it.each(["https://attacker.example/?thread=demo", "/api/v1/devices", "javascript:alert(1)"])(
  "rejects an unsafe notification destination %s",
  async (url) => {
    const worker = await getWorker()
    const payload = { id: 42, body: "Aviso", url }

    await worker.dispatch("push", { data: { text: () => JSON.stringify(payload), json: () => payload } })
    await worker.dispatch("notificationclick", { notification: { close: vi.fn(), data: { url } } })

    expect(worker.showNotification).not.toHaveBeenCalled()
    expect(worker.navigate).not.toHaveBeenCalled()
    expect(worker.openWindow).not.toHaveBeenCalled()
  },
)
