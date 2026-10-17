import type { Bot, ProviderLoginFlow } from "@touri/contracts"
import { useCallback, useEffect, useRef, useState } from "react"
import type { UiApi } from "../../api/client"
import { t } from "../../i18n"
import { retryProviderLogin } from "./providerLogin"

export const CREATE_PROVIDERS = ["codex", "claude", "opencode"] as const

export const useCreateProvider = (api: UiApi | undefined, draftId: string) => {
  const [provider, setProvider] = useState<Bot["provider"]>("codex")
  const [ready, setReady] = useState(!api)
  const [checking, setChecking] = useState(!!api)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  const prepare = useCallback(
    async (next: Bot["provider"], flow: ProviderLoginFlow, current: number) => {
      if (!api || generation.current !== current) return
      const result =
        flow.state === "host-available"
          ? await retryProviderLogin(
              () =>
                api.request(
                  "POST /bots/:id/provider-login/flow",
                  { provider: next, action: "use-host" },
                  { id: draftId },
                ),
              () => generation.current === current,
            )
          : flow
      if (generation.current === current) setReady(result.state === "ready")
    },
    [api, draftId],
  )

  useEffect(() => {
    if (!api) return
    const current = ++generation.current
    setReady(false)
    setError(null)
    setChecking(true)
    const discover = async () => {
      try {
        const results = await Promise.allSettled(
          CREATE_PROVIDERS.map((candidate) =>
            api.request("GET /bots/:id/provider-login/flow", { provider: candidate }, { id: draftId }),
          ),
        )
        if (generation.current !== current) return
        const index = results.findIndex(
          (result) => result.status === "fulfilled" && ["ready", "host-available"].includes(result.value.state),
        )
        const next = CREATE_PROVIDERS[index] ?? "codex"
        const result = results[index]
        setProvider(next)
        if (result?.status === "fulfilled") await prepare(next, result.value, current)
        if (results.some((result) => result.status === "rejected"))
          setError(t("Could not check accounts. Choose an account and try again."))
      } catch {
        if (generation.current === current) setError(t("Could not check accounts. Choose an account and try again."))
      } finally {
        if (generation.current === current) setChecking(false)
      }
    }
    void discover()
    return () => {
      generation.current++
      for (const candidate of CREATE_PROVIDERS)
        void api
          .request("POST /bots/:id/provider-login/flow", { provider: candidate, action: "cancel" }, { id: draftId })
          .catch(() => {})
    }
  }, [api, draftId, prepare])

  const selectProvider = async (next: Bot["provider"]) => {
    const current = ++generation.current
    const previous = provider
    setProvider(next)
    setReady(!api)
    setChecking(!!api)
    setError(null)
    if (!api) return
    try {
      if (previous !== next && !ready)
        await api
          .request("POST /bots/:id/provider-login/flow", { provider: previous, action: "cancel" }, { id: draftId })
          .catch(() => {})
      if (generation.current !== current) return
      const flow = await api.request("GET /bots/:id/provider-login/flow", { provider: next }, { id: draftId })
      await prepare(next, flow, current)
    } catch {
      if (generation.current === current) setError(t("Could not check accounts. Choose an account and try again."))
    } finally {
      if (generation.current === current) setChecking(false)
    }
  }

  return { provider, ready, checking, error, selectProvider, setReady }
}
