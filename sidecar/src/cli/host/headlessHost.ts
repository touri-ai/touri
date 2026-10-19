import type { HostMethods, Kernel } from "@touri/contracts"
import type { SecretStore } from "./secretStore"

export const computerUseDisabledReason =
  "Computer use is disabled in headless server mode: there is no display or desktop session to control"
export const secretPromptTimeoutMs = 5 * 60 * 1000

export type HeadlessHostResult =
  | { success: true; value: unknown }
  | { success: false; errorCode: "HOST_ERROR"; error: string }

const fail = (error: string): HeadlessHostResult => ({ success: false, errorCode: "HOST_ERROR", error })
const done = (value: unknown): HeadlessHostResult => ({ success: true, value })

const isComputerMethod = (method: string): boolean =>
  method.startsWith("computer.") || method.startsWith("permissions.")

const account = (params: unknown): string => String((params as { account?: unknown }).account ?? "")

type Deps = { secrets: SecretStore; publish: Kernel["publish"] }

const handlers: Record<string, (args: { deps: Deps; params: unknown }) => Promise<HeadlessHostResult>> = {
  "keychain.get": async ({ deps, params }) => done({ value: deps.secrets.get(account(params)) }),
  "keychain.set": async ({ deps, params }) => {
    const input = params as HostMethods["keychain.set"]["params"]
    await deps.secrets.set({ account: input.account, value: input.value })
    return done({})
  },
  "keychain.delete": async ({ deps, params }) => {
    await deps.secrets.delete(account(params))
    return done({})
  },
  notify: async ({ deps, params }) => {
    const note = params as HostMethods["notify"]["params"]
    deps.publish({
      type: "notify",
      level: "info",
      title: note.title,
      body: note.body,
      threadId: note.threadId,
      ...(note.requestId === undefined ? {} : { requestId: note.requestId }),
      ...(note.notificationId === undefined ? {} : { notificationId: note.notificationId }),
      ...(note.kind === undefined ? {} : { kind: note.kind }),
    })
    return done({})
  },
  "secret.prompt": async () => {
    await new Promise((resolve) => setTimeout(resolve, secretPromptTimeoutMs))
    return done({ values: null })
  },
}

/**
 * Host bridge for server mode. Secrets live in an encrypted file, notifications become UI events,
 * and everything that needs a desktop (computer use, native secret card) reports why it is unavailable.
 */
export const createHeadlessHost =
  ({ secrets }: { secrets: SecretStore }) =>
  ({ publish, log }: { publish: Kernel["publish"]; log: Kernel["log"] }): Kernel["callHost"] => {
    const call = async (method: string, params: unknown): Promise<HeadlessHostResult> => {
      if (isComputerMethod(method)) return fail(computerUseDisabledReason)
      const handler = handlers[method]
      if (!handler) return fail(`Host method ${method} is not available in headless server mode`)
      try {
        return await handler({ deps: { secrets, publish }, params })
      } catch (error) {
        log({
          level: "error",
          module: "headless-host",
          msg: `host call failed ${method}`,
          data: { error: error instanceof Error ? error.message : String(error) },
        })
        return fail("Secret storage failed")
      }
    }
    return call as Kernel["callHost"]
  }
