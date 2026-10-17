import { expect, it, vi } from "vitest"
import type { TauriInvoke } from "../src/api/client"
import { installNativeDeepLinks } from "../src/nativeDeepLinks"

const link = (requestId: number, bot = "bot-remote") => ({ requestId, bot, thread: "thread-remote" })
const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

it("reads a cold-start target only after registering for live clicks", async () => {
  const calls: string[] = []
  const invoke = vi.fn(async () => {
    calls.push("read")
    return link(1)
  })
  const onLink = vi.fn()
  const stop = installNativeDeepLinks({
    listen: async () => {
      calls.push("listen")
      return () => undefined
    },
    invoke: invoke as unknown as TauriInvoke,
    onLink,
  })
  await settle()
  expect(calls).toEqual(["listen", "read"])
  expect(onLink).toHaveBeenCalledWith(link(1))
  expect(invoke).toHaveBeenCalledWith("deep_link_pending", {})
  expect(invoke).not.toHaveBeenCalledWith("deep_link_ack", expect.anything())
  stop()
})

it("never lets a delayed inbox read overwrite a newer live target and accepts repeated URL clicks", async () => {
  let receive: ((value: unknown) => void) | undefined
  let resolve: ((value: ReturnType<typeof link>) => void) | undefined
  const invoke = vi.fn(
    () =>
      new Promise<ReturnType<typeof link>>((done) => {
        resolve = done
      }),
  )
  const onLink = vi.fn()
  const stop = installNativeDeepLinks({
    listen: async (next) => {
      receive = next
      return () => undefined
    },
    invoke: invoke as unknown as TauriInvoke,
    onLink,
  })
  await settle()
  receive?.(link(2, "bot-newer"))
  resolve?.(link(1, "bot-older"))
  await settle()
  expect(onLink).toHaveBeenCalledTimes(1)
  expect(onLink).toHaveBeenLastCalledWith(link(2, "bot-newer"))
  receive?.(link(2, "bot-newer"))
  receive?.(link(3, "bot-newer"))
  expect(onLink).toHaveBeenCalledTimes(2)
  expect(onLink).toHaveBeenLastCalledWith(link(3, "bot-newer"))
  stop()
})

it("stops a delayed registration without consuming a pending native target", async () => {
  let resolve: ((value: () => void) => void) | undefined
  const unlisten = vi.fn()
  const invoke = vi.fn()
  const onLink = vi.fn()
  const stop = installNativeDeepLinks({
    listen: () =>
      new Promise<() => void>((done) => {
        resolve = done
      }),
    invoke,
    onLink,
  })
  stop()
  resolve?.(unlisten)
  await settle()
  expect(unlisten).toHaveBeenCalledOnce()
  expect(invoke).not.toHaveBeenCalled()
  expect(onLink).not.toHaveBeenCalled()
})
