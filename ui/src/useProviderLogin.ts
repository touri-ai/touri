import type { Bot, ProviderLoginFlow } from "@touri/contracts"
import { useCallback, useEffect, useRef, useState } from "react"
import type { UiApi } from "./api/client"
import { retryProviderLogin } from "./features/bots/providerLogin"
import { openCloudLink } from "./features/cloud/CloudLink"
import { t } from "./i18n"

const openedPages = new WeakMap<UiApi, Set<string>>()

export const useProviderLogin = (
  api: UiApi,
  botId: string,
  provider: Bot["provider"],
  enabled = true,
  autoStart = true,
) => {
  const [flow, setFlow] = useState<ProviderLoginFlow | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const revision = useRef(0)
  const initialized = useRef(false)
  const identity = useRef({ api, botId, provider })
  const matches =
    identity.current.api === api && identity.current.botId === botId && identity.current.provider === provider
  const shouldPoll = !matches || flow === null || flow.state === "waiting"
  const openPage = useCallback(async (url: string) => {
    try {
      await openCloudLink(url)
    } catch {
      setError(t("Não foi possível abrir o navegador. Use o link de login."))
    }
  }, [])
  const act = useCallback(
    async (
      action: "start" | "cancel" | "use-host" | "paste" | "input" | "code",
      value?: string,
      input?: "up" | "down" | "enter",
    ) => {
      const current = generation.current
      const requestedRevision = ++revision.current
      const active = () => current === generation.current && requestedRevision === revision.current
      if (action === "start") openedPages.get(api)?.delete(`${botId}:${provider}`)
      setBusy(true)
      setError(null)
      try {
        const request = () =>
          api.request(
            "POST /bots/:id/provider-login/flow",
            { provider, action, ...(value === undefined ? {} : { value }), ...(input ? { input } : {}) },
            { id: botId },
          )
        const result =
          action === "start" || action === "use-host" ? await retryProviderLogin(request, active) : await request()
        if (!active()) return null
        setFlow(result)
        return result
      } catch {
        if (active()) setError(t("Não foi possível configurar o login. Tente novamente."))
        return null
      } finally {
        if (active()) setBusy(false)
      }
    },
    [api, botId, provider],
  )
  const recheck = useCallback(async () => {
    const current = generation.current
    const requestedRevision = ++revision.current
    const active = () => current === generation.current && requestedRevision === revision.current
    setBusy(true)
    setError(null)
    try {
      const result = await api.request("GET /bots/:id/provider-login/flow", { provider }, { id: botId })
      if (active()) setFlow(result)
      return result
    } catch {
      if (active()) setError(t("Não foi possível verificar o login salvo. Verifique de novo."))
      return null
    } finally {
      if (active()) setBusy(false)
    }
  }, [api, botId, provider])
  useEffect(() => {
    identity.current = { api, botId, provider }
    generation.current++
    initialized.current = false
    setFlow(null)
    setError(null)
    setBusy(false)
    if (!enabled) return
    return () => {
      generation.current++
    }
  }, [api, botId, provider, enabled])
  useEffect(() => {
    if (!enabled || !shouldPoll) return
    const current = generation.current
    let timer: ReturnType<typeof setTimeout>
    let stopped = false
    const poll = async () => {
      const requestedRevision = revision.current
      try {
        const result = await api.request("GET /bots/:id/provider-login/flow", { provider }, { id: botId })
        if (stopped || current !== generation.current) return
        if (requestedRevision === revision.current) {
          setFlow(result)
          setError(null)
          if (autoStart && !initialized.current && result.state === "idle" && result.executable !== "missing") {
            initialized.current = true
            await act("start")
          }
        }
        if (current === generation.current) initialized.current = true
      } catch {
        if (!stopped && current === generation.current && requestedRevision === revision.current)
          setError(t("Não foi possível verificar o login salvo. Verifique de novo."))
      }
      // A rejected read keeps the last known waiting state and its next poll.
      if (!stopped && current === generation.current) timer = setTimeout(() => void poll(), 1000)
    }
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [api, botId, provider, enabled, autoStart, act, shouldPoll])
  useEffect(() => {
    if (!enabled) return
    const refresh = () => {
      void recheck()
    }
    window.addEventListener("focus", refresh)
    window.addEventListener("online", refresh)
    return () => {
      window.removeEventListener("focus", refresh)
      window.removeEventListener("online", refresh)
    }
  }, [enabled, recheck])
  useEffect(() => {
    const host = flow?.hostKind ?? flow?.host
    if (
      !matches ||
      !enabled ||
      provider === "claude" ||
      host === "server" ||
      host === "computer" ||
      flow?.state !== "waiting" ||
      !flow.verificationUrl
    )
      return
    const pages = openedPages.get(api) ?? new Set<string>()
    openedPages.set(api, pages)
    const key = `${botId}:${provider}`
    if (pages.has(key)) return
    pages.add(key)
    void openPage(flow.verificationUrl)
  }, [api, botId, provider, enabled, matches, flow, openPage])
  return {
    flow: matches ? flow : null,
    error: matches ? error : null,
    busy,
    act,
    recheck,
    openPage,
    provider,
    botId,
    blocked: enabled && (!matches || flow?.state !== "ready" || flow.executable === "missing"),
  }
}
